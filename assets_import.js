/* =====================================================================
   ASSET IMPORT — nhập ảnh / GIF / video làm nhân vật hoặc part
   ---------------------------------------------------------------------
   • PNG / JPG / WebP / GIF  → sprite (GIF giữ animation bằng AnimatedSprite)
   • MP4 / WebM / OGV        → PIXI.Texture.from(videoElement) phát realtime
   • Video cũng có thể "chụp khung" thành sprite tĩnh để rig
   • Ảnh nhập vào được LƯU LẠI: server (./assets/imported qua dev_server.js)
     hoặc IndexedDB trình duyệt → mở lại trang asset vẫn còn.
   Tất cả asset được đưa vào AssetLibrary và có thể gán vào bone.
   ===================================================================== */

/* ------------- IndexedDB: kho ảnh/video đã nhập (fallback khi không có server) ------------- */
const AssetsDB = {
    DB: 'rigstudio_assets', STORE: 'files', _db: null,
    async open() {
        if (this._db) return this._db;
        if (typeof indexedDB === 'undefined') throw new Error('IndexedDB không khả dụng');
        this._db = await new Promise((res, rej) => {
            const rq = indexedDB.open(this.DB, 1);
            rq.onupgradeneeded = () => {
                const db = rq.result;
                if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE);
            };
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error || new Error('IndexedDB lỗi'));
        });
        return this._db;
    },
    async _tx(mode, fn) {
        const db = await this.open();
        return new Promise((res, rej) => {
            const tx = db.transaction(this.STORE, mode);
            const store = tx.objectStore(this.STORE);
            const out = fn(store);
            tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
            tx.onerror = () => rej(tx.error);
        });
    },
    async put(key, blob) {
        try { return await this._tx('readwrite', s => s.put(blob, key)); }
        catch (e) { console.warn('IndexedDB put lỗi', e); return null; }
    },
    async get(key) {
        try { return await this._tx('readonly', s => s.get(key)); }
        catch (e) { return null; }
    },
    async keys() {
        try { const r = await this._tx('readonly', s => s.getAllKeys()); return r || []; }
        catch (e) { return []; }
    },
    async del(key) {
        try { return await this._tx('readwrite', s => s.delete(key)); }
        catch (e) { return null; }
    }
};

const AssetLibrary = {
    items: [],          // { id, name, kind:'image'|'gif'|'video', url, w, h, texture|frames }
    _seq: 0,
    /** asset lưu trên server (GET /api/asset) → nạp lại sau khi F5 */
    persisted: [],

    /** nhận File từ input / drop, đọc và tạo Pixi asset.
     * Ảnh/video được LƯU LẠI (server ./assets/imported nếu chạy qua dev_server.js,
     *  ngược lại lưu vào IndexedDB của trình duyệt) → mở lại trang vẫn còn. */
    async addFile(file, opts) {
        const kind = this.detectKind(file);
        if (!kind) throw new Error('Định dạng không hỗ trợ: ' + (file.name || ''));
        const keep = !(opts && opts.persist === false);
        const silent = !!(opts && opts.silent);

        // 1) LƯU file: server (./assets/imported) trước, fallback IndexedDB
        const saved = keep ? await this.saveFile(file, kind) : null;
        const url = (saved && saved.url) || URL.createObjectURL(file);
        const id = 'asset_' + (++this._seq) + '_' + Date.now();
        const item = {
            id, name: file.name, kind, url, file, w: 0, h: 0,
            persisted: keep ? !!saved : !!(opts && opts.store),
            store: saved ? saved.store : ((opts && opts.store) || null),
            savedName: saved ? saved.name : ((opts && opts.store) ? file.name : null)
        };
        this.items.push(item);

        if (kind === 'image' || kind === 'gif') {
            const img = await this.loadImage(url);
            item.w = img.naturalWidth;
            item.h = img.naturalHeight;
            item.image = img;
            item.texture = PIXI.Texture.from(img);
        } else if (kind === 'video') {
            const v = await this.loadVideo(url);
            item.w = v.videoWidth;
            item.h = v.videoHeight;
            item.video = v;
            item.texture = PIXI.Texture.from(v);
        }

        renderAssetLibrary();
        if (!silent) {
            addChatMessage('assistant', `**Đã import**: \`${item.name}\` (${kind}, ${item.w}×${item.h})` +
                (item.persisted ? ' — 💾 đã lưu lại, mở lại trang vẫn còn.' : '') +
                '\n\nChọn bone rồi bấm vào asset để gán, hoặc dùng nút **Dùng làm nhân vật**.');
            toast('Import: ' + item.name + (item.persisted ? ' ✓ đã lưu' : ''));
        }
        return item;
    },

    detectKind(file) {
        const t = (file.type || '').toLowerCase();
        const n = (file.name || '').toLowerCase();
        if (t === 'image/gif' || n.endsWith('.gif')) return 'gif';
        if (/^image\/(png|jpeg|jpg|webp|bmp|avif)$/.test(t)) return 'image';
        if (/^video\/(mp4|webm|ogg|quicktime|x-matroska)$/.test(t)) return 'video';
        if (/\.(png|jpg|jpeg|webp|bmp|avif)$/.test(n)) return 'image';
        if (/\.(mp4|webm|ogv|mov|mkv)$/.test(n)) return 'video';
        return null;
    },

    /* --------- LƯU ẢNH ĐÃ NHẬP ---------
       • Có dev_server.js  → POST /api/asset, file nằm ở ./assets/imported/<tên>
         và được phục vụ tĩnh nên còn nguyên sau khi reload.
       • Không có server   → IndexedDB (rigstudio_assets) giữ blob theo tên file. */
    async saveFile(file, kind) {
        if (/^https?:/.test(location.protocol)) {
            try {
                const r = await fetch('/api/asset', {
                    method: 'POST',
                    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'asset.png') },
                    body: file
                });
                const d = await r.json().catch(() => ({}));
                if (r.ok && d.url) {
                    this.persisted.unshift({ name: d.name, url: d.url, size: d.size });
                    toast('Đã lưu ảnh vào assets/imported/' + d.name);
                    return { url: d.url, name: d.name, store: 'server' };
                }
                if (r.status !== 404 && r.status !== 405) throw new Error(d.error || ('HTTP ' + r.status));
            } catch (e) {
                // 404/405 = trang tĩnh (Live Server) → chuyển sang IndexedDB
                if (!/HTTP (404|405)/.test(e.message)) console.warn('[asset] lưu qua server lỗi, dùng IndexedDB:', e.message);
            }
        }
        const key = file.name || ('asset-' + Date.now());
        await AssetsDB.put(key, file);
        this.persisted.unshift({ name: key, url: null, size: file.size || 0 });
        toast('Đã lưu ảnh vào IndexedDB của trình duyệt');
        return { url: null, name: key, store: 'idb' };
    },

    /** file đã lưu (IndexedDB) → File để dựng lại asset sau khi reload */
    async fileFromStore(name) {
        return AssetsDB.get(name);
    },

    /** nạp lại toàn bộ asset đã lưu (server + IndexedDB) — bỏ qua khi đang ở Rig SVG */
    async restore() {
        const seen = new Set(this.items.map(i => i.name));
        let n = 0;
        // 1) server
        if (/^https?:/.test(location.protocol)) {
            try {
                const r = await fetch('/api/asset');
                if (r.ok) {
                    const d = await r.json();
                    this.persisted = (d.items || []).map(it => ({ name: it.name, url: it.url, size: it.size }));
                    for (const it of (d.items || []).reverse()) {
                        if (seen.has(it.name)) continue;
                        try {
                            const blob = await (await fetch(it.url)).blob();
                            const f = new File([blob], it.name, { type: blob.type || 'image/png' });
                            await this.addFile(f, { persist: false, silent: true, store: 'server' });
                            seen.add(it.name);
                            n++;
                        } catch (e) { /* file lỗi → bỏ qua */ }
                    }
                }
            } catch (e) { /* server không có /api/asset → thử IndexedDB */ }
        }
        // 2) IndexedDB (lấp những file chưa có: chế độ không server, hoặc file chưa lên server)
        try {
            const keys = await AssetsDB.keys();
            for (const k of keys) {
                if (seen.has(k)) continue;
                const f = await AssetsDB.get(k);
                if (f) { await this.addFile(f, { persist: false, silent: true, store: 'idb' }); seen.add(k); n++; }
            }
        } catch (e) { /* IndexedDB bị chặn → thôi */ }
        return n;
    },

    loadImage(url) {
        return new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('Không đọc được ảnh'));
            i.src = url;
        });
    },

    loadVideo(url) {
        return new Promise((res, rej) => {
            const v = document.createElement('video');
            v.src = url;
            v.crossOrigin = 'anonymous';
            v.muted = true;
            v.loop = true;
            v.playsInline = true;
            v.preload = 'auto';
            const ok = () => { v.removeEventListener('loadeddata', ok); res(v); };
            v.addEventListener('loadeddata', ok);
            v.onerror = () => rej(new Error('Không đọc được video'));
            v.load();
        });
    },

    /** GIF: tách frame (nếu canvas hỗ trợ), trả về mảng texture */
    async gifFrames(item) {
        if (item.frames) return item.frames;
        const frames = [];
        // Trình duyệt không expose frame GIF; dùng ImageDecoder nếu có
        if ('ImageDecoder' in window) {
            try {
                const data = await item.file.arrayBuffer();
                const dec = new ImageDecoder({ data, type: item.file.type || 'image/gif' });
                await dec.tracks.ready;
                const count = dec.tracks.selectedTrack.frameCount || 1;
                for (let i = 0; i < Math.min(count, 120); i++) {
                    const { image } = await dec.decode({ frameIndex: i });
                    const cv = document.createElement('canvas');
                    cv.width = image.displayWidth;
                    cv.height = image.displayHeight;
                    cv.getContext('2d').drawImage(image, 0, 0);
                    frames.push(PIXI.Texture.from(cv));
                }
            } catch (e) { console.warn('GIF decode lỗi', e); }
        }
        if (!frames.length) frames.push(item.texture);
        item.frames = frames;
        return frames;
    },

    byId(id) { return this.items.find(a => a.id === id) || null; },

    /** URL còn dùng được cho asset: /assets/imported (server) hoặc blob hiện tại,
     *  nếu không còn thì dựng lại blob từ IndexedDB (file đã lưu). */
    async resolveUrl(item) {
        if (!item) return null;
        if (item.url && !/^blob:/.test(item.url)) return item.url;   // URL server → bền
        if (/^blob:/.test(item.url || '')) return item.url;          // blob còn sống trong phiên
        const f = item.file || await AssetsDB.get(item.name);
        if (!f) return null;
        item.url = URL.createObjectURL(f);
        return item.url;
    },

    /** Dựng lại texture cho asset có URL blob đã chết (sau F5) — gọi lúc boot */
    async repair() {
        let n = 0;
        for (const item of this.items) {
            const url = await this.resolveUrl(item);
            if (!url || (url === item.url && item.w > 0 && item.texture)) continue;
            try {
                const img = await this.loadImage(url);
                item.url = url; item.image = img;
                item.w = img.naturalWidth; item.h = img.naturalHeight;
                if (item.texture) { try { item.texture.destroy(true); } catch (e) { } }
                item.texture = PIXI.Texture.from(img);
                item.repaired = true; n++;
            } catch (e) { /* ảnh hỏng → bỏ qua */ }
        }
        if (n) renderAssetLibrary();
        return n;
    },

    /** tải asset đang có về máy (dùng URL đã lưu hoặc blob hiện tại) */
    download(id) {
        const item = this.byId(id);
        if (!item) return;
        const a = document.createElement('a');
        a.href = item.url;
        a.download = item.name || 'asset';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('Đang tải ' + item.name);
    },

    remove(id) {
        const i = this.items.findIndex(a => a.id === id);
        if (i < 0) return;
        const item = this.items[i];
        if (item.video) { item.video.pause(); item.video.src = ''; }
        if (/^blob:/.test(item.url)) URL.revokeObjectURL(item.url);
        // xoá luôn bản đã lưu nếu có (server ./assets/imported hoặc IndexedDB)
        if (item.savedName) {
            this.persisted = this.persisted.filter(p => p.name !== item.savedName);
            if (item.store === 'idb') AssetsDB.del(item.savedName);
            else if (/^https?:/.test(location.protocol)) {
                fetch('/api/asset?name=' + encodeURIComponent(item.savedName), { method: 'DELETE' }).catch(() => { });
            }
        }
        this.items.splice(i, 1);
        renderAssetLibrary();
        toast('Đã xoá ' + item.name);
    },

    /** dùng asset làm nhân vật: 1 sprite duy nhất thay cho rig part */
    useAsCharacter(id) {
        const item = this.byId(id);
        if (!item || !Engine.scene) return;
        buildCustomSprite(Engine.scene, item);
        // Reset _fitted để layoutSpine() chạy lại sau khi add ảnh mới
        if (Engine._fitted !== undefined) Engine._fitted = false;
        // Thêm sprite vào PixiJS stage nếu chưa có
        if (Engine.app?.stage && Engine.scene?.world) Engine.app.stage.addChild(Engine.scene.world);
        // Resize canvas + force render để ảnh hiển thị ngay trong viewport
        if (Engine.app?.resize) Engine.app.resize();
        if (Engine.app?.render) Engine.app.render();
        toast('Nhân vật ← ' + item.name);
        addChatMessage('assistant', `Đã dùng \`${item.name}\` làm nhân vật. Nhấn **Auto Rig (Spine)** để quay lại rig từ atlas.`);
    },

    /**
     * Dùng ảnh vừa import như ATLAS để auto-rig (giống hệt
     * assets/images/Cartoon RPG Character Rig Sprite Sheet.png).
     * Ảnh phải đúng bố cục lưới part của atlas gốc (1672×941) vì toạ độ cell
     * trong ATLAS_PARTS đọc theo pixel của atlas đó.
     */
    async useAsAtlas(id) {
        const item = this.byId(id);
        if (!item || !Engine.scene) return;
        if (item.kind === 'video') { toast('Không dùng video làm atlas'); return; }
        const url = await this.resolveUrl(item);
        if (!url) { toast('Không đọc được ảnh'); return; }
        try {
            const img = await this.loadImage(url);
            const W = img.naturalWidth, H = img.naturalHeight;
            const sheet = PartAtlas.images.sheet;
            const sw = sheet ? sheet.naturalWidth : 1672, sh = sheet ? sheet.naturalHeight : 941;
            // thay ảnh atlas gốc bằng ảnh vừa import
            PartAtlas.images.sheet = img;
            PartAtlas.textures.sheet = PIXI.Texture.from(img);
            PartAtlas._trim = {};                        // đo lại cell cho ảnh mới
            const tight = (ATLAS_SOURCES.sheet || {}).tight;
            if (!tight) delete ATLAS_SOURCES.sheet.tight; // ảnh tự cắt nền? chỉ áp khi ảnh khớp
            const exact = (W === sw && H === sh);
            if (exact) ATLAS_SOURCES.sheet.tight = true;
            // dựng lại rig từ atlas mới
            if (typeof clearCustomCharacter === 'function') clearCustomCharacter(Engine.scene);
            const s = SpineRig.build(Engine.scene, false);
            const attached = s.ordered.filter(b => b.sprite).length;
            Engine.animation.loadClips(DEFAULT_CLIPS(), true);
            Engine.isPlaying = true; togglePlayState(true);
            setStatus(`Atlas = ${item.name} (${W}×${H}) · ${s.ordered.length} bones · ${attached} parts`);
            addChatMessage('assistant', `🧩 **Atlas = ảnh vừa import**: \`${item.name}\` (${W}×${H}).

` +
                `Rig lại được **${attached}/${s.ordered.length}** bộ phận — sang tab **Animate** để chạy clip.

` +
                (exact ? '' : '⚠️ Ảnh không đúng kích thước atlas gốc ' + sw + '×' + sh +
                    ' nên các bộ phận có thể lệch; hãy dùng ảnh cùng bố cục lưới như atlas gốc.'));
            toast('Đã dùng ảnh làm atlas — sang tab Animate');
        } catch (e) {
            toast('Lỗi dùng atlas: ' + e.message);
        }
    }
};

/* ---------------- UI ---------------- */
function renderAssetLibrary() {
    // HTML thực tế dùng #panel-assets (trước đây code tìm #assets-library → không bao giờ hiện)
    const el = document.getElementById('panel-assets') || document.getElementById('assets-library');
    if (!el) return;
    el.innerHTML = '';
    /* KHÔNG tự bật display: nếu đang ở tab Parts mà render lại Assets thì panel
       Assets sẽ đè lên Parts (2 lưới chồng nhau). Chỉ set grid khi panel đang
       được phép hiện (tab Assets đang mở). */
    if (el.style.display !== 'none') el.style.display = 'grid';
    if (!AssetLibrary.items.length) {
        el.innerHTML = '<div class="col-span-3 text-[10px] text-slate-400 text-center py-3">Chưa có asset nào.<br>Kéo thả hoặc bấm Import.</div>';
        return;
    }
    AssetLibrary.items.forEach(item => {
        const card = document.createElement('div');
        /* ĐỒNG BỘ với .part-chip của tab Parts: cùng bo góc, cùng chiều cao tối
           thiểu, cùng khung ảnh 52px để 2 tab trông như một khối thống nhất. */
        card.className = 'relative rounded-md border border-slate-200 bg-white overflow-hidden group';
        card.style.minHeight = '58px';
        const thumb = document.createElement('canvas');
        const scale = Math.min(1, 52 / Math.max(1, item.w), 52 / Math.max(1, item.h));
        thumb.width = Math.max(1, item.w * scale);
        thumb.height = Math.max(1, item.h * scale);
        const ctx = thumb.getContext('2d');
        if (item.kind === 'video' && item.video) {
            try { ctx.drawImage(item.video, 0, 0, thumb.width, thumb.height); }
            catch (e) { ctx.fillStyle = '#e2e8f0'; ctx.fillRect(0, 0, thumb.width, thumb.height); }
        } else if (item.image) {
            ctx.drawImage(item.image, 0, 0, thumb.width, thumb.height);
        }
        thumb.className = 'mx-auto';
        thumb.style.display = 'block';
        card.appendChild(thumb);

        const kindBadge = item.kind === 'video' ? 'VID' : item.kind === 'gif' ? 'GIF' : 'IMG';
        // badge "đã lưu": file nằm trong assets/imported (server) hoặc IndexedDB
        const savedBadge = item.persisted
            ? `<span class="absolute top-0 right-0 text-[7px] px-1 bg-emerald-600 text-white rounded-bl" title="Đã lưu (${item.store === 'server' ? 'assets/imported/' + item.savedName : 'IndexedDB'})">✓ lưu</span>` : '';
        card.insertAdjacentHTML('beforeend',
            `<span class="absolute top-0 left-0 text-[7px] px-1 bg-slate-800 text-white rounded-br">${kindBadge}</span>
             ${savedBadge}
             <div class="px-1 pb-0.5 text-[8px] leading-[1.1] text-center text-slate-500 truncate">${item.name}</div>
             <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex-col items-center justify-center gap-1 transition">
                <div class="flex gap-1">
                    <button data-act="use" class="text-[8px] bg-emerald-500 text-white px-1 py-0.5 rounded" title="Dùng cả ảnh làm nhân vật (1 sprite)">Dùng</button>
                    <button data-act="atlas" class="text-[8px] bg-purple-500 text-white px-1 py-0.5 rounded" title="Dùng ảnh này làm atlas rồi auto-rig từng bộ phận">Atlas</button>
                    <button data-act="dl" class="text-[8px] bg-sky-500 text-white px-1 py-0.5 rounded">Tải</button>
                    <button data-act="del" class="text-[8px] bg-red-500 text-white px-1 py-0.5 rounded">Xoá</button>
                </div>
             </div>`);
        card.addEventListener('click', e => {
            const act = e.target.dataset.act;
            if (act === 'del') { AssetLibrary.remove(item.id); return; }
            if (act === 'use') { AssetLibrary.useAsCharacter(item.id); return; }
            if (act === 'atlas') { AssetLibrary.useAsAtlas(item.id); return; }
            if (act === 'dl') { AssetLibrary.download(item.id); return; }
            if (Engine.selectedBone) Engine.assignAsset(item.id);
        });
        el.appendChild(card);
    });
}

/** mở hộp chọn file */
function pickAssets() {
    const input = document.getElementById('asset-file');
    if (input) { input.value = ''; input.click(); }
}

async function onAssetFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setLibraryTab('assets');
    let ok = 0;
    for (const f of files) {
        try { await AssetLibrary.addFile(f); ok++; }
        catch (e) {
            toast('Lỗi: ' + e.message);
            addChatMessage('assistant', `⚠️ Không import được \`${f.name}\`: ${e.message}`);
        }
    }
    if (ok) setLibraryTab('assets');
}

/* kéo thả vào viewport */
function initAssetDrop() {
    const zone = document.getElementById('main-viewport-container');
    const hint = document.getElementById('drop-hint');
    if (!zone) return;
    const showHint = on => {
        if (hint) {
            hint.classList.toggle('hidden', !on);
            hint.classList.toggle('flex', on);
        }
    };
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        showHint(true);
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        showHint(false);
    }));
    zone.addEventListener('drop', e => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) onAssetFiles(files);
    });
}

/* gán asset vào bone đang chọn */
Engine.assignAsset = async function (assetId) {
    const item = AssetLibrary.byId(assetId);
    if (!item || !this.selectedBone || !this.scene.spine) { toast('Chọn bone trước'); return; }
    const bone = this.scene.spine.bones.get(this.selectedBone);
    if (!bone) return;
    // URL blob có thể đã chết sau F5 → dựng lại từ IndexedDB/server trước khi tạo sprite
    const url = await AssetLibrary.resolveUrl(item);
    if (url !== item.url) {
        try {
            const img = await AssetLibrary.loadImage(url);
            item.url = url; item.image = img;
            item.w = img.naturalWidth; item.h = img.naturalHeight;
            item.texture = PIXI.Texture.from(img);
        } catch (e) { toast('Không đọc lại được ảnh đã lưu'); return; }
    }
    if (!item.texture) { toast('Asset không có texture'); return; }
    if (bone.sprite) { bone.sprite.destroy(); bone.sprite = null; }
    const sp = new PIXI.Sprite(item.texture);
    sp.anchor.set(0.5, item.kind === 'video' ? 0.5 : 1);
    if (item.kind === 'video' && item.video) { item.video.play().catch(() => { }); }
    // gắn part vào container bone (giữ nguyên z-order của bone trong rigLayer)
    bone.container.addChild(sp);
    bone.sprite = sp;
    bone.partKey = null;
    bone.assetId = assetId;
    renderSpineBonesList();
    toast(`Bone ${bone.name} ← ${item.name}`);
};

/* nhân vật từ 1 ảnh/video duy nhất — gắn thẳng vào stage (không qua scene.world
   để tránh bị nhân đôi scale/translate của layoutSpine) */
function buildCustomSprite(scene, item) {
    if (scene.rigLayer) { scene.rigLayer.destroy({ children: true }); scene.rigLayer = null; }
    scene.spine = null;
    scene.spineDebug = null;
    scene.rigReady = false;
    scene.rigLayer = new PIXI.Container();
    scene.rigLayer.label = 'custom_layer';
    // 1) thử stage trước, nếu không có thì dùng sceneRoot
    (scene.app.stage).addChild(scene.rigLayer);

    const sp = new PIXI.Sprite(item.texture);
    sp.anchor.set(0.5, 1);
    sp.label = 'custom_character';
    scene.rigLayer.addChild(sp);
    scene.customSprite = sp;

    if (item.kind === 'video') item.video.play().catch(function () {});
    layoutCustom(scene);
    setText('bone-count', 0);
    const el = document.getElementById('bones-list');
    if (el) el.innerHTML = '<div class="px-2 py-2 text-[10px] text-slate-400">Nhân vật là sprite đơn (chưa có rig). Bấm Auto Rig để dựng lại từ atlas.</div>';
}

function layoutCustom(scene) {
    const sp = scene.customSprite;
    if (!sp || !scene.rigLayer) return;
    const W = scene.app.renderer.width, H = scene.app.renderer.height;
    const w = Math.max(1, sp.texture.width || sp.width);
    const h = Math.max(1, sp.texture.height || sp.height);
    const s = Math.min((W * 0.9) / w, (H * 0.9) / h);
    // rigLayer đang nằm trên stage (không bị world biến đổi): đặt theo pixel màn hình
    scene.rigLayer.scale.set(s);
    scene.rigLayer.position.set(W / 2, H / 2 + (h * s) / 2);
    // sprite neo (0.5,1) => đáy ảnh nằm đúng đáy khung
}

/** gọi lại khi viewport đổi kích thước (resize) */
function relayoutCustom() {
    if (typeof Engine !== 'undefined' && Engine.scene && Engine.scene.customSprite) layoutCustom(Engine.scene);
}

window.AssetLibrary = AssetLibrary;
window.AssetsDB = AssetsDB;
window.pickAssets = pickAssets;
window.onAssetFiles = onAssetFiles;
window.initAssetDrop = initAssetDrop;
window.renderAssetLibrary = renderAssetLibrary;

/* Nạp lại asset đã lưu sau khi tải trang (server ./assets/imported + IndexedDB).
   Chờ engine boot xong để renderAssetLibrary() có chỗ hiển thị. */
window.addEventListener('load', () => {
    const t0 = Date.now();
    const tick = async () => {
        if (window.Engine && Engine.app) {
            try {
                const n = await AssetLibrary.restore();
                // asset nạp lại từ IndexedDB có URL blob đã chết → dựng lại texture
                const fixed = await AssetLibrary.repair();
                if (n || fixed) {
                    renderAssetLibrary();
                    toast(`Đã nạp lại ${n} asset đã lưu`);
                }
            } catch (e) { console.warn('[asset] restore lỗi:', e.message); }
            // dán ảnh từ clipboard (Ctrl+V) vào viewport → import + lưu
            document.addEventListener('paste', e => {
                const files = [...((e.clipboardData && e.clipboardData.files) || [])]
                    .filter(f => /^image\//.test(f.type));
                if (files.length) { e.preventDefault(); onAssetFiles(files); }
            });
            return;
        }
        if (Date.now() - t0 > 30000) return;
        setTimeout(tick, 200);
    };
    tick();
});