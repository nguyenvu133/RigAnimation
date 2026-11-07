/* =====================================================================
   RIG ADVANCED — 15 công cụ rig nâng cao cho Rig Studio
   ---------------------------------------------------------------------
   Nạp SAU pixijs_v8_engine_openai_api.js / spine_rig.js / assets_import.js
   (dùng chung scope global của các script classic).

   1  Kéo-xoay bone trực tiếp trong viewport (Alt = di chuyển bone)
   2  IK 2 xương cho chân: bật/tắt + kéo target ghim chân
   3  Tạo / nhân bản / xoá / đổi cha bone (giữ nguyên vị trí world)
   4  Trình sửa bone nâng cao: scale, length, inherit rotation/scale
   5  Khoá & ẩn bone (lock / hide) — ẩn cả part trong viewport
   6  Đối xứng hoá bộ xương L ↔ R (symmetrize)
   7  Copy / dán / lật pose (mirror pose trái-phải)
   8  Undo / Redo cho mọi thao tác rig & pose (Ctrl+Z / Ctrl+Shift+Z)
   9  Thư viện pose: 6 slot lưu / áp / xoá
   10 Nội suy key: linear / ease / ease-in / ease-out / step
   11 Biên tập keyframe: thêm tại playhead, xoá, kéo theo thời gian
   12 Tua timeline (scrub) + tốc độ phát
   13 Quản lý clip: tạo / nhân bản / đổi tên / xoá / đổi duration
   14 Onion skin: xương mờ của khung trước & sau
   15 Sinh phụ diễn tự động (tóc / vạt áo / vũ khí trễ pha)
   ===================================================================== */

const RigAdvanced = {
    ready: false,
    undoStack: [],
    redoStack: [],
    ikOn: false,
    ikTargets: { L: null, R: null },
    lock: new Set(),          // bone bị khoá (không sửa / không kéo)
    hidden: new Set(),        // bone bị ẩn part
    poses: [],                // thư viện pose
    onion: { on: false, before: null, after: null },
    speed: 1,
    _drag: null,

    /* ------------------------------------------------------------------
       tiện ích chung
       ------------------------------------------------------------------ */
    scene() { return (typeof Engine !== 'undefined' && Engine.scene) || null; },
    skel() { const s = this.scene(); return (s && s.spine) || null; },
    world() { const s = this.scene(); return s && s.world; },

    deg(b) { return Math.atan2(b.wb, b.wa) * 180 / Math.PI; },
    rad(d) { return d * Math.PI / 180; },

    /** toạ độ con trỏ (client) → hệ toạ độ skeleton (nghịch đảo ma trận world) */
    toLocal(ev) {
        const s = this.scene();
        if (!s || !s.app || !s.world) return { x: 0, y: 0 };
        const r = s.app.canvas.getBoundingClientRect();
        const scr = s.app.renderer.screen;
        const sx = (ev.clientX - r.left) * (r.width ? scr.width / r.width : 1);
        const sy = (ev.clientY - r.top) * (r.height ? scr.height / r.height : 1);
        // world là ảnh của rigLayer trong stage (scale + translate) → tự nghịch đảo
        const sc = s.world.scale.x || 1;
        return { x: (sx - s.world.x) / sc, y: (sy - s.world.y) / sc };
    },

    /** 1 world px → px màn hình (để hit-test theo pixel cho dễ bấm) */
    px() {
        const s = this.scene();
        const sc = s && s.world ? Math.abs(s.world.scale.x) || 1 : 1;
        return 1 / sc;
    },

    selected() {
        const sk = this.skel();
        return (sk && Engine.selectedBone) ? sk.bones.get(Engine.selectedBone) || null : null;
    },

    pushUndo(label) {
        const sk = this.skel();
        if (!sk) return;
        const snap = sk.ordered.map(b => ({
            n: b.name, x: b.x, y: b.y, r: b.rotation, sx: b.scaleX, sy: b.scaleY,
            len: b.length, ir: b.inheritRotation, is: b.inheritScale
        }));
        this.undoStack.push({ label: label || 'edit', snap, time: Engine.playTime });
        if (this.undoStack.length > 60) this.undoStack.shift();
        this.redoStack.length = 0;
    },

    restore(snap) {
        const sk = this.skel();
        if (!sk) return;
        snap.forEach(st => {
            const b = sk.bones.get(st.n);
            if (!b) return;
            b.x = st.x; b.y = st.y; b.rotation = st.r;
            b.scaleX = st.sx; b.scaleY = st.sy; b.length = st.len;
            b.inheritRotation = st.ir; b.inheritScale = st.is;
        });
        sk.setupPose();
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.render();
        renderSpineBonesList();
    },

    undo() {
        const e = this.undoStack.pop();
        if (!e) { toast('Không còn gì để Undo'); return; }
        this.redoStack.push(e);
        this.restore(e.snap);
        toast('Undo: ' + e.label);
    },

    redo() {
        const e = this.redoStack.pop();
        if (!e) { toast('Không còn gì để Redo'); return; }
        this.undoStack.push(e);
        this.restore(e.snap);
        toast('Redo: ' + e.label);
    },
    /* ---------------- POSE (feature 7 + 9) ---------------- */
    capturePose() {
        const sk = this.skel();
        if (!sk) return null;
        const p = {};
        sk.ordered.forEach(b => { p[b.name] = { x: b.qx, y: b.qy, r: b.qrot, sx: b.qsx, sy: b.qsy }; });
        return p;
    },

    applyPose(pose, opts) {
        const sk = this.skel();
        if (!sk || !pose) return;
        Object.keys(pose).forEach(n => {
            const b = sk.bones.get(n), p = pose[n];
            if (!b || !p) return;
            b.qx = p.x; b.qy = p.y; b.qrot = p.r; b.qsx = p.sx; b.qsy = p.sy;
        });
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        const s = this.scene();
        if (s && s.drawSpineDebug) s.drawSpineDebug();
        this.render();
    },

    /** lật pose trái ↔ phải: đổi tên _L ↔ _R, đảo rotation và x */
    mirrorPose(pose) {
        const sk = this.skel();
        if (!sk || !pose) return null;
        const flip = n => /_L$/.test(n) ? n.replace(/_L$/, '_R')
            : /_R$/.test(n) ? n.replace(/_R$/, '_L')
                : n;
        const out = {};
        Object.keys(pose).forEach(n => {
            const p = pose[n], t = flip(n);
            out[t] = { x: -p.x, y: p.y, r: -p.r, sx: p.sx, sy: p.sy };
        });
        return out;
    },

    copyPose() {
        const p = this.capturePose();
        if (!p) { toast('Chưa có skeleton'); return; }
        this._poseClip = p;
        toast('Đã copy pose');
        this.render();
    },

    pastePose(mirror) {
        const p = this._poseClip;
        if (!p) { toast('Chưa copy pose nào'); return; }
        this.pushUndo(mirror ? 'dán pose lật' : 'dán pose');
        this.applyPose(mirror ? this.mirrorPose(p) : p);
        toast(mirror ? 'Đã dán pose (lật L↔R)' : 'Đã dán pose');
    },

    /** lưu pose hiện tại vào slot 1..6 (localStorage → còn sau khi F5) */
    saveSlot(i) {
        const p = this.capturePose();
        if (!p) return;
        this.poses[i] = { name: 'Pose ' + (i + 1), pose: p, at: Date.now() };
        try { localStorage.setItem('pixi_pose_slots', JSON.stringify(this.poses)); } catch (e) { }
        toast('Đã lưu pose vào slot ' + (i + 1));
        this.render();
    },

    loadSlots() {
        try {
            const raw = localStorage.getItem('pixi_pose_slots');
            if (raw) this.poses = JSON.parse(raw) || [];
        } catch (e) { this.poses = []; }
    },

    applySlot(i) {
        const s = this.poses[i];
        if (!s || !s.pose) { toast('Slot ' + (i + 1) + ' trống'); return; }
        this.pushUndo('áp pose slot ' + (i + 1));
        this.applyPose(s.pose);
        toast('Đã áp ' + s.name);
    },

    delSlot(i) {
        this.poses[i] = null;
        try { localStorage.setItem('pixi_pose_slots', JSON.stringify(this.poses)); } catch (e) { }
        this.render();
    },
/* ---------------- 1. kéo/xoay bone trong viewport ---------------- */
    setupViewportInteraction() {
        const s = this.scene();
        if (!s || !s.app) return;
        const cv = s.app.canvas;
        if (this._bound === cv) return;
        this._bound = cv;
        cv.addEventListener('pointerdown', e => this.onDown(e));
        window.addEventListener('pointermove', e => this.onMove(e));
        window.addEventListener('pointerup', e => this.onUp(e));
        document.addEventListener('keydown', e => this.onKey(e));
    },

    /** vị trí world của joint bone */
    jointOf(b) { return { x: b.wx, y: b.wy }; },

    /** bone gần con trỏ nhất (khớp hoặc giữa thân xương), bán kính 26px màn hình */
    pickBone(pos) {
        const sk = this.skel();
        if (!sk) return null;
        const w = (this.scene().world.scale.x) || 1;
        const rad = 26 / Math.abs(w);
        let best = null, bestD = rad;
        sk.ordered.forEach(b => {
            if (this.hidden.has(b.name)) return;
            const d1 = Math.hypot(b.wx - pos.x, b.wy - pos.y);
            // part treo theo −Y của bone: hướng thân xương = góc world + 90°
            const th = Math.atan2(b.wb, b.wa) + Math.PI / 2;
            const mx = b.wx + Math.cos(th) * (b.length || 0) * 0.55;
            const my = b.wy + Math.sin(th) * (b.length || 0) * 0.55;
            const d2 = Math.hypot(mx - pos.x, my - pos.y);
            const d = Math.min(d1, d2);
            if (d < bestD) { bestD = d; best = b; }
        });
        return best;
    },

    onDown(ev) {
        if (ev.button !== 0) return;
        const sk = this.skel();
        if (!sk) return;
        const pos = this.toLocal(ev);
        // 1) IK đang bật → ưu tiên kéo target bàn chân
        if (this.ikOn) {
            for (const side of ['L', 'R']) {
                const t = this.ikTargets[side];
                if (t && Math.hypot(t.x - pos.x, t.y - pos.y) < 26 / Math.abs(this.scene().world.scale.x || 1)) {
                    this._drag = { mode: 'ik', side, before: this.snapBones() };
                    ev.preventDefault();
                    return;
                }
            }
        }
        // 2) chọn bone gần nhất
        const b = this.pickBone(pos);
        if (!b) return;
        if (this.lock.has(b.name)) { toast('Bone ' + b.name + ' đang khoá'); return; }
        try { Engine.selectBone(b.name); } catch (e) { Engine.selectedBone = b.name; }
        this._drag = {
            mode: (ev.altKey || ev.shiftKey) ? 'move' : 'rotate',
            bone: b,
            before: this.snapBones(),
            startX: b.x, startY: b.y,
            last: pos
        };
        ev.preventDefault();
    },

    onMove(ev) {
        const d = this._drag;
        if (!d) return;
        const sk = this.skel();
        if (!sk) return;
        const pos = this.toLocal(ev);

        if (d.mode === 'ik') {
            this.ikTargets[d.side] = { x: pos.x, y: pos.y };
            this.solveIK();
            SpineRig.syncBoneContainers(sk);
            this.drawOverlay();
            return;
        }

        const b = d.bone;
        if (d.mode === 'move') {
            const p = b.parent;
            const dx = pos.x - d.last.x, dy = pos.y - d.last.y;
            if (p) {
                const det = p.wa * p.wd - p.wb * p.wc || 1;
                b.x += (p.wd * dx - p.wc * dy) / det;
                b.y += (-p.wb * dx + p.wa * dy) / det;
            } else { b.x += dx; b.y += dy; }
            d.last = pos;
            b.qx = b.x; b.qy = b.y;
        } else {
            /* Part treo theo −Y của bone ⟹ hướng nhìn φ = 90° + góc world.
               Muốn part chỉ về con trỏ: góc world = φ − 90 ⇒ qrot = gócWorld − gócCha. */
            const pd = b.parent ? this.deg(b.parent) : 0;
            const phi = Math.atan2(pos.y - b.wy, pos.x - b.wx) * 180 / Math.PI;
            b.rotation = +(phi - 90 - pd).toFixed(2);
            b.qrot = b.rotation;
        }
        sk.updateWorldTransform();
        this.solveIK();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.drawOverlay();
    },

    onUp() {
        const d = this._drag;
        this._drag = null;
        if (!d || d.mode === 'ik') return;
        const after = this.snapBones();
        const label = (d.mode === 'move' ? 'di chuyển bone ' : 'xoay bone ') + d.bone.name;
        this.push({ label, before: d.before, after });
        try { Engine.selectBone(d.bone.name); } catch (e) { }
        renderSpineBonesList();
    },

    onKey(ev) {
        const tag = (ev.target && ev.target.tagName) || '';
        if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
            ev.preventDefault();
            ev.shiftKey ? this.redo() : this.undo();
        }
        if (ev.key === 'Delete' || ev.key === 'Backspace') {
            if (Engine.selectedBone) { ev.preventDefault(); this.deleteBone(Engine.selectedBone); }
        }
    },/* ---------------- 2. IK 2 xương cho chân ---------------- */
    toggleIK() {
        this.ikOn = !this.ikOn;
        if (this.ikOn) this.initIKTargets();
        this.render();
        toast(this.ikOn ? 'IK bật — kéo vòng tròn ở cổ chân để ghim chân' : 'IK tắt');
    },

    legBones(side) {
        const sk = this.skel();
        if (!sk) return null;
        const a = sk.bones.get('leg_upper_' + side) || sk.bones.get('leg_up_' + side);
        const b = sk.bones.get('leg_lower_' + side) || sk.bones.get('leg_low_' + side);
        if (!a || !b) return null;
        return { b1: a, b2: b };
    },

    /** target khởi tạo = góc hiện tại của bàn chân */
    initIKTargets() {
        const sk = this.skel();
        if (!sk) return;
        ['L', 'R'].forEach(side => {
            if (this.ikTargets[side]) return;
            const f = sk.bones.get('foot_' + side);
            const lb = this.legBones(side);
            if (!lb) return;
            const th = Math.atan2(lb.b2.wb, lb.b2.wa) + Math.PI / 2;
            const ax = f ? f.wx : lb.b2.wx + Math.cos(th) * lb.b2.length;
            const ay = f ? f.wy : lb.b2.wy + Math.sin(th) * lb.b2.length;
            this.ikTargets[side] = { x: ax, y: ay };
        });
        this.drawOverlay();
    },

    /**
     * Giải IK 2 xương trong "không gian hướng part" (part treo theo −Y của bone).
     * φ = hướng đoạn xương trên màn hình (atan2, độ) · φ_rest = 90° khi buông thẳng xuống.
     * φ1 = base − s·α ; φ2 = φ1 + s·(180 − β) ; qrot = (φ − 90) − góc world của cha.
     */
    solveIK() {
        if (!this.ikOn) return;
        const sk = this.skel();
        if (!sk) return;
        let changed = false;
        ['L', 'R'].forEach(side => {
            const t = this.ikTargets[side];
            const lb = this.legBones(side);
            if (!t || !lb) return;
            const { b1, b2 } = lb;
            const l1 = Math.max(1, b1.length), l2 = Math.max(1, b2.length);
            const dx = t.x - b1.wx, dy = t.y - b1.wy;
            const dist = Math.hypot(dx, dy);
            const d = Math.max(Math.abs(l1 - l2) + 0.01, Math.min(l1 + l2 - 0.01, dist || 0.01));
            const base = Math.atan2(dy, dx) * 180 / Math.PI;
            const ac = v => Math.acos(Math.max(-1, Math.min(1, v))) * 180 / Math.PI;
            const alpha = ac((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d));
            const beta = ac((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2));
            const s = side === 'L' ? 1 : -1;           // gối gập về phía trước
            const phi1 = base - s * alpha;
            const phi2 = phi1 + s * (180 - beta);
            const pd = b1.parent ? this.deg(b1.parent) : 0;
            b1.qrot = +(phi1 - 90 - pd).toFixed(2);
            b2.qrot = +(phi2 - phi1).toFixed(2);
            b1.rotation = b1.qrot; b2.rotation = b2.qrot;
            changed = true;
        });
        if (changed) sk.updateWorldTransform();
    },
    /* ---------------- 3. Bone management ---------------- */
    /** tạo bone mới (giữ container phẳng như engine: con trực tiếp của rigLayer) */
    addBoneRaw(def) {
        const sk = this.skel();
        if (!sk || sk.bones.has(def.name)) return null;
        const b = new SpineBone({
            name: def.name, parent: def.parent || null,
            x: +def.x || 0, y: +def.y || 0, rotation: +def.rotation || 0,
            length: Math.max(4, +def.length || 40),
            scaleX: +def.scaleX || 1, scaleY: +def.scaleY || 1,
            inheritRotation: def.inheritRotation !== false,
            inheritScale: def.inheritScale !== false
        });
        b.container = new PIXI.Container();
        b.container.label = 'spineBone_' + b.name;
        sk.bones.set(b.name, b);
        if (b.parentName && sk.bones.has(b.parentName)) {
            b.parent = sk.bones.get(b.parentName);
            b.parent.children.push(b);
        }
        // chèn SAU cha trong ordered (cha luôn được cập nhật trước con)
        const pi = b.parent ? sk.ordered.indexOf(b.parent) : -1;
        if (pi >= 0) sk.ordered.splice(pi + 1, 0, b); else sk.ordered.push(b);
        const layer = this.scene().rigLayer;
        if (layer && b.container) layer.addChild(b.container);
        // đảm bảo graphics debug + overlay luôn nằm trên
        const s = this.scene();
        if (s.spineDebug && s.spineDebug.parent === layer) layer.addChild(s.spineDebug);
        if (this.ghostG && this.ghostG.parent === layer) layer.addChild(this.ghostG);
        if (this.overlay && this.overlay.parent === layer) layer.addChild(this.overlay);
        return b;
    },/** xoá bone: con của nó được đẩy lên cha nó (giữ nguyên toạ độ local) */
    removeBoneRaw(name) {
        const sk = this.skel();
        const b = sk && sk.bones.get(name);
        if (!b) return null;
        const parent = b.parent;
        (b.children || []).slice().forEach(ch => {
            ch.parentName = b.parentName;
            ch.parent = parent;
            if (parent) parent.children.push(ch);
        });
        if (parent) {
            const i = parent.children.indexOf(b);
            if (i >= 0) parent.children.splice(i, 1);
        }
        sk.bones.delete(name);
        const oi = sk.ordered.indexOf(b);
        if (oi >= 0) sk.ordered.splice(oi, 1);
        if (b.container) {
            if (b.container.parent) b.container.parent.removeChild(b.container);
            b.container.destroy({ children: true });
        }
        this.lock.delete(name); this.hidden.delete(name);
        return b;
    },

    createBone(name, parentName) {
        const sk = this.skel();
        if (!sk) return;
        const clean = String(name || '').trim().replace(/[^\w.-]+/g, '_');
        if (!clean) { toast('Tên bone không hợp lệ'); return; }
        if (sk.bones.has(clean)) { toast('Bone đã tồn tại: ' + clean); return; }
        const parentName2 = parentName && sk.bones.has(parentName) ? parentName : (sk.bones.has('torso') ? 'torso' : null);
        const def = { name: clean, parent: parentName2, x: 0, y: parentName2 ? 20 : 0, length: 40 };
        this.push({ label: 'tạo bone ' + clean, before: this.snapBones(), after: null });
        this.addBoneRaw(def);
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.undoStack[this.undoStack.length - 1].after = this.snapBones();
        try { Engine.selectBone(clean); } catch (e) { }
        renderSpineBonesList();
        toast('Đã tạo bone: ' + clean);
    },

    duplicateBone(name) {
        const sk = this.skel();
        const b = sk && sk.bones.get(name);
        if (!b) { toast('Chọn bone trước'); return; }
        const nn = (b.name + '_copy').replace(/[^\w.-]+/g, '_');
        if (sk.bones.has(nn)) { toast('Đã có ' + nn); return; }
        this.push({ label: 'nhân bản bone ' + b.name, before: this.snapBones(), after: null });
        const nb = this.addBoneRaw({
            name: nn, parent: b.parentName, x: b.x + 16, y: b.y,
            rotation: b.rotation, length: b.length,
            scaleX: b.scaleX, scaleY: b.scaleY,
            inheritRotation: b.inheritRotation, inheritScale: b.inheritScale
        });
        if (nb && b.sprite) {
            // copy cả part đang gắn (dùng lại texture, không nhân bản ảnh)
            const sp = new PIXI.Sprite(b.sprite.texture);
            sp.anchor.copyFrom(b.sprite.anchor);
            sp.pivot.copyFrom(b.sprite.pivot);
            sp.baseRot = b.sprite.baseRot || 0;
            sp.position.copyFrom(b.sprite.position);
            sp.rotation = b.sprite.rotation;
            nb.container.addChild(sp);
            nb.sprite = sp;
            nb.partKey = b.partKey;
        }
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.undoStack[this.undoStack.length - 1].after = this.snapBones();
        try { Engine.selectBone(nn); } catch (e) { }
        renderSpineBonesList();
        toast('Đã nhân bản: ' + nn);
    },

    deleteBone(name) {
        const sk = this.skel();
        const b = sk && sk.bones.get(name);
        if (!b) return;
        if (/^(root|hips|torso|head)$/.test(name)) { toast('Không xoá bone hệ thống: ' + name); return; }
        const before = this.snapBones();
        this.removeBoneRaw(name);
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.push({ label: 'xoá bone ' + name, before, after: this.snapBones() });
        Engine.selectedBone = null;
        renderSpineBonesList();
        toast('Đã xoá bone: ' + name);
    },
reparentBone(name, newParentName) {
        const sk = this.skel();
        const b = sk && sk.bones.get(name);
        const np = sk && sk.bones.get(newParentName);
        if (!b || !np || b === np) { toast('Chọn bone và cha mới hợp lệ'); return; }
        if (this.isAncestorOf(b, np)) { toast('Không thể đổi cha vào chính con của nó'); return; }
        const before = this.snapBones();
        // giữ nguyên vị trí world: đổi sang local của cha mới
        const wx = b.wx, wy = b.wy;
        if (b.parent) {
            const i = b.parent.children.indexOf(b);
            if (i >= 0) b.parent.children.splice(i, 1);
        }
        const det = np.wa * np.wd - np.wb * np.wc || 1;
        const dx = wx - np.wx, dy = wy - np.wy;
        const lx = (np.wd * dx - np.wc * dy) / det;
        const ly = (-np.wb * dx + np.wa * dy) / det;
        b.parentName = newParentName;
        b.parent = np;
        np.children.push(b);
        b.x = b.qx = +lx.toFixed(2);
        b.y = b.qy = +ly.toFixed(2);
        this.reorder();
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.push({ label: 'đổi cha ' + name + ' → ' + newParentName, before, after: this.snapBones() });
        renderSpineBonesList();
        toast('Đã đổi cha: ' + name + ' → ' + newParentName);
    },

    isAncestorOf(a, b) {
        let p = b.parent;
        while (p) { if (p === a) return true; p = p.parent; }
        return false;
    },

    /** sắp xếp lại ordered: cha luôn trước con (DFS từ root) */
    reorder() {
        const sk = this.skel();
        if (!sk) return;
        const out = [], seen = new Set();
        const roots = sk.ordered.filter(b => !b.parent);
        const walk = b => {
            if (!b || seen.has(b.name)) return;
            seen.add(b.name); out.push(b);
            (b.children || []).forEach(walk);
        };
        roots.forEach(walk);
        sk.ordered.forEach(b => walk(b));   // bone mồ côi / vòng lỗi
        sk.ordered = out;
    },/* ---------------- 4. trình sửa bone nâng cao ---------------- */
    updateBoneProperties(name, props) {
        const sk = this.skel();
        const b = sk && sk.bones.get(String(name || '').trim());
        if (!b) { toast('Chọn bone trước'); return; }
        const before = this.snapBones();
        const p = props || {};
        if (isFinite(parseFloat(p.x))) b.x = parseFloat(p.x);
        if (isFinite(parseFloat(p.y))) b.y = parseFloat(p.y);
        if (isFinite(parseFloat(p.rotation))) b.rotation = parseFloat(p.rotation);
        if (isFinite(parseFloat(p.length))) b.length = Math.max(1, parseFloat(p.length));
        if (isFinite(parseFloat(p.scaleX))) b.scaleX = Math.max(0.01, parseFloat(p.scaleX));
        if (isFinite(parseFloat(p.scaleY))) b.scaleY = Math.max(0.01, parseFloat(p.scaleY));
        if (typeof p.inheritRotation === 'boolean') b.inheritRotation = p.inheritRotation;
        if (typeof p.inheritScale === 'boolean') b.inheritScale = p.inheritScale;
        b.qx = b.x; b.qy = b.y; b.qrot = b.rotation; b.qsx = b.scaleX; b.qsy = b.scaleY;
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.push({ label: 'sửa bone ' + b.name, before, after: this.snapBones() });
        try { Engine.selectBone(b.name); } catch (e) { }
    },

    /** đọc thuộc tính bone vào các input trong panel */
    fillBoneInputs(name) {
        const sk = this.skel();
        const b = sk && sk.bones.get(name);
        const set = (id, v, on) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!on;
            else if (v !== undefined) el.value = v;
        };
        if (!b) return;
        set('inp-bone-x', b.x.toFixed(1));
        set('inp-bone-y', b.y.toFixed(1));
        set('inp-bone-rot', b.rotation.toFixed(1));
        set('inp-bone-length', b.length.toFixed(1));
        set('inp-bone-scalex', b.scaleX.toFixed(2));
        set('inp-bone-scaley', b.scaleY.toFixed(2));
        set('chk-bone-inherit-rot', null, b.inheritRotation);
        set('chk-bone-inherit-scale', null, b.inheritScale);
    },

    applyBoneInputs() {
        const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
        const chk = id => { const el = document.getElementById(id); return el ? el.checked : true; };
        this.updateBoneProperties(Engine.selectedBone, {
            x: g('inp-bone-x'), y: g('inp-bone-y'), rotation: g('inp-bone-rot'),
            length: g('inp-bone-length'), scaleX: g('inp-bone-scalex'), scaleY: g('inp-bone-scaley'),
            inheritRotation: chk('chk-bone-inherit-rot'), inheritScale: chk('chk-bone-inherit-scale')
        });
        toast('Đã cập nhật thuộc tính bone');
    },

    /* ---------------- 5. khoá / ẩn bone ---------------- */
    toggleLock(name) {
        const n = name || Engine.selectedBone;
        if (!n) { toast('Chọn bone trước'); return; }
        this.lock.has(n) ? this.lock.delete(n) : this.lock.add(n);
        this.render(); renderSpineBonesList();
        toast(this.lock.has(n) ? 'Đã khoá ' + n : 'Đã mở khoá ' + n);
    },

    toggleHide(name) {
        const n = name || Engine.selectedBone;
        const sk = this.skel();
        const b = sk && sk.bones.get(n);
        if (!b) { toast('Chọn bone trước'); return; }
        const hide = !this.hidden.has(n);
        hide ? this.hidden.add(n) : this.hidden.delete(n);
        if (b.container) b.container.visible = !hide;
        this.render(); renderSpineBonesList(); this.drawOverlay();
        toast(hide ? 'Đã ẩn ' + n : 'Đã hiện ' + n);
    },

    /* ---------------- 6. đối xứng hoá L ↔ R ---------------- */
    symmetrize() {
        const sk = this.skel();
        if (!sk) return;
        const before = this.snapBones();
        let n = 0;
        sk.ordered.forEach(b => {
            if (!/_L$/.test(b.name)) return;
            const rn = b.name.replace(/_L$/, '_R');
            const rb = sk.bones.get(rn);
            if (!rb) return;
            rb.x = -b.x; rb.y = b.y; rb.rotation = -b.rotation;
            rb.length = b.length; rb.scaleX = b.scaleX; rb.scaleY = b.scaleY;
            rb.qx = rb.x; rb.qy = rb.y; rb.qrot = rb.rotation;
            rb.qsx = rb.scaleX; rb.qsy = rb.scaleY;
            n++;
        });
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.push({ label: 'đối xứng L↔R', before, after: this.snapBones() });
        this.drawOverlay();
        toast(n ? `Đã đối xứng ${n} cặp xương L→R` : 'Không tìm thấy cặp _L/_R');
    },/* ---------------- 11. Timeline: key at playhead, scrub ---------------- */
    addKeyframe() {
        const tr = this.track(true);
        if (!tr) return;
        const t = +(Engine.playTime || 0).toFixed(3);
        const s = sampleTrack(tr.keys, t);
        tr.keys = tr.keys.filter(k => Math.abs(k.t - t) > 0.012);
        tr.keys.push({ t, x: s.x, y: s.y, rotation: s.rotation, scale: s.scale, ease: 'linear' });
        tr.keys.sort((a, b) => a.t - b.t);
        this.commitTimeline('thêm key');
        toast(`Đã thêm key ${tr.bone} @ ${t}s`);
    },deleteKeyframe() {
        const tr = this.track(false);
        if (!tr) return;
        const t = Engine.playTime || 0;
        const i = this.nearestKey(tr, t);
        if (i < 0) { toast('Không có key gần playhead'); return; }
        tr.keys.splice(i, 1);
        this.commitTimeline('xoá key');
        toast('Đã xoá key tại ' + t.toFixed(2) + 's');
    },

    nearestKey(tr, t, tol) {
        const d = tol === undefined ? Math.max(0.06, (Engine.animation.currentClip ? 0.06 : 0.06)) : tol;
        let best = -1, bd = d;
        (tr.keys || []).forEach((k, i) => {
            const dd = Math.abs(k.t - t);
            if (dd < bd) { bd = dd; best = i; }
        });
        return best;
    },

    /** 10. nội suy cho key gần playhead (hoặc cả track nếu không có key nào gần) */
    setInterpolation(type) {
        const tr = this.track(false);
        if (!tr) { toast('Chọn bone có track trong clip này'); return; }
        const i = this.nearestKey(tr, Engine.playTime || 0, 0.12);
        if (i >= 0) tr.keys[i].ease = type;
        else tr.keys.forEach(k => { k.ease = type; });
        this.commitTimeline('nội suy ' + type);
        toast('Nội suy ' + type + ' → ' + tr.bone);
    },

    /** track của bone đang chọn trong clip hiện tại (tạo nếu cần) */
    track(create) {
        const a = Engine.animation;
        const clip = a && a.currentClip;
        if (!clip) { toast('Chưa có clip'); return null; }
        const bone = Engine.selectedBone;
        if (!bone) { toast('Chọn bone trước'); return null; }
        let tr = clip.tracks.find(t => t.bone === bone);
        if (!tr && create) { tr = { bone, keys: [] }; clip.tracks.push(tr); }
        if (!tr) { toast('Bone ' + bone + ' chưa có track trong clip này'); return null; }
        return tr;
    },

    /** đẩy snapshot timeline (clip + playhead) vào undo */
    commitTimeline(label) {
        const a = Engine.animation;
        const after = JSON.parse(JSON.stringify(a.clips || []));
        const before = this._tlBefore || after;
        this.undoStack.push({
            label, kind: 'timeline', before, after,
            clipId: a.currentClip ? a.currentClip.id : null
        });
        if (this.undoStack.length > 60) this.undoStack.shift();
        this.redoStack.length = 0;
        this._tlBefore = null;
        renderDopesheet(); updateClipHUD(); this.render();
    },

    markTimeline() { this._tlBefore = JSON.parse(JSON.stringify(Engine.animation.clips || [])); },

    /* ---------------- 12. scrub + tốc độ phát ---------------- */
    setPlaybackSpeed(s) {
        this.speed = Math.max(0.1, Math.min(4, +s || 1));
        this.render();
        toast('Tốc độ phát: ' + this.speed + 'x');
    },

    scrubTo(t) {
        const c = Engine.animation.currentClip;
        const dur = c ? c.duration : 1;
        Engine.playTime = Math.max(0, Math.min(dur, +t || 0));
        setText('current-frame', Engine.playTime.toFixed(2));
        SpineRig.applyPose(this.scene(), c, Engine.playTime);
        this.solveIK();
        SpineRig.syncBoneContainers(this.skel());
        this.scene().drawSpineDebug();
        this.drawOverlay();
        this.drawPlayhead();
    },/* ---------------- 13. quản lý clip ---------------- */
    createClip(name, duration) {
        const a = Engine.animation;
        const id = ('clip_' + String(name || 'new').trim().toLowerCase().replace(/[^\w]+/g, '_')).slice(0, 24) || ('clip_' + Date.now());
        if (a.clips.some(c => c.id === id)) { toast('Clip đã tồn tại: ' + id); return; }
        const dur = Math.max(0.2, +duration || 1.5);
        a.clips.push({ id, name: String(name || 'Clip mới'), duration: dur, tracks: [] });
        this.markTimeline();
        a.setCurrent(id);
        this.commitTimeline('tạo clip ' + id);
        toast('Đã tạo clip ' + name + ' (' + dur + 's) — thêm track bằng cách chọn bone rồi "Thêm key"');
    },

    duplicateClip(name) {
        const a = Engine.animation;
        const src = a.clips.find(c => c.id === name) || a.currentClip;
        if (!src) return;
        let id = src.id + '_copy', i = 2;
        while (a.clips.some(c => c.id === id)) id = src.id + '_copy' + (i++);
        this.markTimeline();
        a.clips.push({ id, name: src.name + ' copy', duration: src.duration, tracks: JSON.parse(JSON.stringify(src.tracks)) });
        a.setCurrent(id);
        this.commitTimeline('nhân bản clip');
        toast('Đã nhân bản: ' + id);
    },

    deleteClip(name) {
        const a = Engine.animation;
        if (a.clips.length <= 1) { toast('Phải giữ ít nhất 1 clip'); return; }
        const id = name || (a.currentClip && a.currentClip.id);
        this.markTimeline();
        const i = a.clips.findIndex(c => c.id === id);
        if (i < 0) return;
        a.clips.splice(i, 1);
        a.loadClips(a.clips, false);
        this.commitTimeline('xoá clip');
        toast('Đã xoá clip ' + id);
    },

    renameClip(id, name) {
        const a = Engine.animation;
        const c = a.clips.find(x => x.id === id) || a.currentClip;
        if (!c) return;
        const nn = String(name || '').trim();
        if (!nn) { toast('Tên rỗng'); return; }
        this.markTimeline();
        c.name = nn;
        this.commitTimeline('đổi tên clip');
        toast('Clip → ' + nn);
    },

    setClipDuration(id, duration) {
        const a = Engine.animation;
        const c = a.clips.find(x => x.id === id) || a.currentClip;
        if (!c) return;
        const d = Math.max(0.2, Math.min(60, +duration || c.duration));
        this.markTimeline();
        c.duration = +d.toFixed(2);
        // kẹp key vượt duration
        c.tracks.forEach(t => { t.keys = (t.keys || []).filter(k => k.t <= c.duration + 0.001); });
        this.commitTimeline('đổi duration');
        toast('Duration ' + c.name + ': ' + c.duration + 's');
    },/* ---------------- 14. onion skin ---------------- */
    toggleOnion() {
        this.onion.on = !this.onion.on;
        if (!this.onion.on) this.clearGhosts();
        this.render(); this.drawPlayhead();
        toast(this.onion.on ? 'Onion skin: hiện xương khung trước/sau' : 'Đã tắt onion skin');
    },
    toggleOnionSkin() { this.toggleOnion(); },

    clearGhosts() {
        if (this.ghostG) { this.ghostG.clear(); }
    },

    /** skeleton rút gọn để vẽ ghost (không sprite, không container) */
    ghostSkeleton() {
        const sk = this.skel();
        if (!sk) return null;
        if (this._ghostOf === sk && this._ghost) return this._ghost;
        const defs = sk.ordered.map(b => ({
            name: b.name, parent: b.parentName, x: b.x, y: b.y,
            rotation: b.rotation, length: b.length,
            scaleX: b.scaleX, scaleY: b.scaleY,
            inheritRotation: b.inheritRotation, inheritScale: b.inheritScale
        }));
        const g = new SpineSkeleton();
        g.build(defs);
        g.setupPose = () => g.setToSetupPose();
        this._ghost = g; this._ghostOf = sk;
        return g;
    },

    /** đặt pose cho ghost theo clip tại thời điểm t (không đụng skeleton thật) */
    poseGhost(g, clip, t) {
        if (!g) return;
        g.setToSetupPose();
        if (clip) {
            clip.tracks.forEach(tr => {
                const b = g.bones.get(tr.bone);
                if (!b || !tr.keys || !tr.keys.length) return;
                const s = sampleTrack(tr.keys, t);
                b.qx += s.x; b.qy += s.y; b.qrot += s.rotation;
                b.qsx *= s.scale; b.qsy *= s.scale;
            });
        }
        g.updateWorldTransform();
    },

    drawGhosts() {
        if (!this.onion.on) return;
        const s = this.scene(), sk = this.skel();
        if (!s || !sk || !s.rigLayer) return;
        if (!this.ghostG) {
            this.ghostG = new PIXI.Graphics();
            s.rigLayer.addChild(this.ghostG);
        }
        const g = this.ghostG;
        g.clear();
        const gs = this.ghostSkeleton();
        const clip = Engine.animation.currentClip;
        const dur = clip ? clip.duration : 1;
        const delta = this.onion.delta || 0.08;
        const w = Math.abs(s.world.scale.x) || 1;
        const items = [
            { t: Engine.playTime - delta, color: 0x60a5fa, alpha: 0.55 },
            { t: Engine.playTime + delta, color: 0xf59e0b, alpha: 0.55 }
        ];
        items.forEach(it => {
            const t = ((it.t % dur) + dur) % dur;
            this.poseGhost(gs, clip, t);
            gs.ordered.forEach(b => {
                if (!b.length || this.hidden.has(b.name)) return;
                // hướng part: −Y của bone
                const th = Math.atan2(b.wb, b.wa) + Math.PI / 2;
                const ex = b.wx + Math.cos(th) * b.length;
                const ey = b.wy + Math.sin(th) * b.length;
                g.moveTo(b.wx, b.wy).lineTo(ex, ey)
                    .stroke({ width: 2 / w, color: it.color, alpha: it.alpha });
                g.circle(b.wx, b.wy, 2.4 / w).fill({ color: it.color, alpha: it.alpha * 0.8 });
            });
        });
    },/* ---------------- 15. sinh phụ diễn tự động ---------------- */
    /** tóc / vạt áo / vũ khí trễ pha so với thân: thêm track vào clip hiện tại */
    enableSecondaryMotion() {
        const a = Engine.animation;
        const clip = a && a.currentClip;
        const sk = this.skel();
        if (!clip || !sk) { toast('Chưa có clip/skeleton'); return; }
        // chọn "nguồn" chuyển động: torso (thân) → hips, nếu không có thì bone có biên độ lớn nhất
        const byBone = n => clip.tracks.find(t => t.bone === n && t.keys.length);
        const driver = byBone('torso') || byBone('hips') || clip.tracks
            .slice().sort((p, q) => this.trackAmplitude(q) - this.trackAmplitude(p))[0];
        if (!driver) { toast('Clip chưa có track nào để lấy chuyển động'); return; }

        const targets = sk.ordered
            .map(b => b.name)
            .filter(n => /hair|weapon|sword|skirt|cape|body_core|tail|beard|loincloth|belt/i.test(n));
        if (!targets.length) { toast('Không tìm thấy bone phụ diễn (hair/cape/weapon...)'); return; }

        this.markTimeline();
        const delay = 0.08;
        const factor = 0.55;
        let added = 0;
        targets.forEach((name, idx) => {
            if (name === driver.bone) return;
            let tr = clip.tracks.find(t => t.bone === name);
            if (!tr) { tr = { bone: name, keys: [] }; clip.tracks.push(tr); added++; }
            // key trễ pha + biên độ nhỏ hơn, lệch pha nhẹ giữa các bone để tự nhiên
            const lag = delay + idx * 0.012;
            const amp = factor / (1 + idx * 0.18);
            const out = [];
            const dur = clip.duration;
            const stepN = 8;
            for (let i = 0; i <= stepN; i++) {
                const t = +(dur * i / stepN).toFixed(3);
                const s = sampleTrack(driver.keys, Math.max(0, t - lag));
                out.push({
                    t, x: +(s.x * amp).toFixed(3), y: +(s.y * amp).toFixed(3),
                    rotation: +(s.rotation * amp).toFixed(3), scale: 1, ease: 'ease'
                });
            }
            // key đầu/cuối trùng nhau để loop sạch
            out[out.length - 1].x = out[0].x;
            out[out.length - 1].y = out[0].y;
            out[out.length - 1].rotation = out[0].rotation;
            tr.keys = out;
        });
        this.commitTimeline('phụ diễn tự động');
        toast(`Đã sinh phụ diễn cho ${targets.length} bone (trễ ${delay}s, biên độ ${Math.round(factor * 100)}%)`);
    },

    trackAmplitude(tr) {
        if (!tr || !tr.keys || tr.keys.length < 2) return 0;
        let mn = Infinity, mx = -Infinity;
        tr.keys.forEach(k => {
            const v = (k.rotation || 0) + Math.abs(k.x || 0) + Math.abs(k.y || 0);
            mn = Math.min(mn, v); mx = Math.max(mx, v);
        });
        return mx - mn;
    },/* ---------------- overlay: trục xương đúng hướng + target IK ---------------- */
    drawOverlay() {
        const s = this.scene(), sk = this.skel();
        if (!s || !sk || !s.rigLayer) return;
        if (!this.overlay) {
            this.overlay = new PIXI.Graphics();
            s.rigLayer.addChild(this.overlay);
        }
        const g = this.overlay;
        g.clear();
        const w = Math.abs(s.world.scale.x) || 1;

        // khung xương đúng hướng part (chỉ khi bật checkbox "Trục xương")
        const showAxes = document.getElementById('chk-bone-axes');
        if (showAxes && showAxes.checked) {
            sk.ordered.forEach(b => {
                if (this.hidden.has(b.name)) return;
                const th = Math.atan2(b.wb, b.wa) + Math.PI / 2;
                const ex = b.wx + Math.cos(th) * (b.length || 0);
                const ey = b.wy + Math.sin(th) * (b.length || 0);
                const col = b.name === Engine.selectedBone ? 0x7c3aed : 0x64748b;
                g.moveTo(b.wx, b.wy).lineTo(ex, ey).stroke({ width: (b.name === Engine.selectedBone ? 2.5 : 1.5) / w, color: col, alpha: 0.7 });
                g.circle(b.wx, b.wy, 2.6 / w).fill({ color: col, alpha: 0.9 });
            });
        }

        // target IK + dây nối tới cổ chân
        if (this.ikOn) {
            ['L', 'R'].forEach(side => {
                const t = this.ikTargets[side];
                const lb = this.legBones(side);
                if (!t || !lb) return;
                g.circle(t.x, t.y, 7 / w).stroke({ width: 2 / w, color: 0x06b6d4, alpha: 0.95 })
                    .fill({ color: 0x06b6d4, alpha: 0.28 });
                g.moveTo(t.x, t.y).lineTo(lb.b2.wx, lb.b2.wy)
                    .stroke({ width: 1 / w, color: 0x06b6d4, alpha: 0.5 });
            });
        }
    },

    /* ---------------- timeline: vạch playhead + kéo key ---------------- */
    drawPlayhead() {
        const layer = document.getElementById('dopesheet-keyframes-layer');
        if (!layer) return;
        const clip = Engine.animation.currentClip;
        const holder = layer.parentElement;
        if (!clip || !holder) return;
        let ph = document.getElementById('rig-playhead');
        if (!ph) {
            ph = document.createElement('div');
            ph.id = 'rig-playhead';
            ph.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:#ef4444;pointer-events:none;z-index:5';
            holder.appendChild(ph);
        }
        const pct = Math.max(0, Math.min(1, (Engine.playTime || 0) / (clip.duration || 1)));
        ph.style.left = (pct * 100) + '%';
    },

    /** gắn scrub (bấm/kéo trên timeline) + kéo key, gọi 1 lần */
    bindTimeline() {
        const layer = document.getElementById('dopesheet-keyframes-layer');
        if (!layer || this._tlBound) return;
        this._tlBound = true;
        const holder = layer.parentElement;

        const timeFromEvent = ev => {
            const r = holder.getBoundingClientRect();
            const clip = Engine.animation.currentClip;
            const p = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
            return p * ((clip && clip.duration) || 1);
        };
        const scrubbing = ev => {
            if (Engine.isPlaying) { Engine.isPlaying = false; togglePlayState(false); }
            this.scrubTo(timeFromEvent(ev));
        };
        holder.addEventListener('pointerdown', ev => {
            if (ev.target && ev.target.classList && ev.target.classList.contains('rig-key')) return;
            holder.setPointerCapture && holder.setPointerCapture(ev.pointerId);
            this._scrub = true; scrubbing(ev);
        });
        holder.addEventListener('pointermove', ev => {
            if (this._scrub) scrubbing(ev);
            else if (this._keyDrag) this.dragKey(ev, timeFromEvent(ev));
        });
        const stop = () => { this._scrub = false; this._keyDrag = null; };
        holder.addEventListener('pointerup', stop);
        holder.addEventListener('pointercancel', stop);
        holder.addEventListener('pointerleave', () => { this._scrub = false; });
    },

    dragKey(ev, t) {
        const d = this._keyDrag;
        if (!d) return;
        const clip = Engine.animation.currentClip;
        const tr = clip && clip.tracks.find(x => x.bone === d.bone);
        if (!tr || !tr.keys[d.i]) return;
        tr.keys[d.i].t = +Math.max(0, Math.min(clip.duration, t)).toFixed(3);
        tr.keys.sort((a, b) => a.t - b.t);
        d.i = tr.keys.findIndex(k => k === tr.keys[d.i]) >= 0 ? d.i : tr.keys.findIndex(k => k.t === tr.keys[d.i].t);
        renderDopesheet();
        this.drawPlayhead();
    },/* ---------------- undo / redo (dùng chung cho rig + timeline) ---------------- */
    /** snapshot thuộc tính bone (đủ để dựng lại pose và cấu trúc cơ bản) */
    snapBones() {
        const sk = this.skel();
        if (!sk) return null;
        return sk.ordered.map(b => ({
            name: b.name, parent: b.parentName,
            x: b.x, y: b.y, rotation: b.rotation, length: b.length,
            scaleX: b.scaleX, scaleY: b.scaleY,
            inheritRotation: b.inheritRotation, inheritScale: b.inheritScale,
            part: b.partKey || null
        }));
    },

    applySnap(snap) {
        const sk = this.skel();
        if (!sk || !snap) return;
        const have = new Set(sk.ordered.map(b => b.name));
        // xoá bone không còn trong snapshot
        sk.ordered.slice().forEach(b => { if (!snap.some(s => s.name === b.name)) this.removeBoneRaw(b.name); });
        // tạo lại bone thiếu + gán thuộc tính
        snap.forEach(s => {
            if (!have.has(s.name)) this.addBoneRaw(s);
            const b = sk.bones.get(s.name);
            if (!b) return;
            b.parentName = s.parent;
            b.parent = s.parent ? sk.bones.get(s.parent) || null : null;
            b.x = s.x; b.y = s.y; b.rotation = s.rotation; b.length = s.length;
            b.scaleX = s.scaleX; b.scaleY = s.scaleY;
            b.inheritRotation = s.inheritRotation; b.inheritScale = s.inheritScale;
            b.qx = b.x; b.qy = b.y; b.qrot = b.rotation; b.qsx = b.scaleX; b.qsy = b.scaleY;
            if (b.container) b.container.visible = !this.hidden.has(b.name);
        });
        this.reorder();
        sk.updateWorldTransform();
        SpineRig.syncBoneContainers(sk);
        this.scene().drawSpineDebug();
        this.drawOverlay();
        renderSpineBonesList();
    },

    push(e) {
        if (!e) return;
        this.undoStack.push(e);
        if (this.undoStack.length > 60) this.undoStack.shift();
        this.redoStack.length = 0;
        this.render();
    },

    restoreEntry(e, side) {
        if (!e) return;
        if (e.kind === 'timeline') {
            const a = Engine.animation;
            const clips = JSON.parse(JSON.stringify(side === 'undo' ? e.before : e.after));
            a.loadClips(clips, false);
            if (e.clipId && clips.some(c => c.id === e.clipId)) a.setCurrent(e.clipId);
            renderDopesheet(); updateClipHUD();
        } else {
            this.applySnap(side === 'undo' ? e.before : e.after);
        }
    },

    undo() {
        const e = this.undoStack.pop();
        if (!e) { toast('Không còn gì để Undo'); return; }
        this.redoStack.push(e);
        this.restoreEntry(e, 'undo');
        toast('Undo: ' + e.label);
    },

    redo() {
        const e = this.redoStack.pop();
        if (!e) { toast('Không còn gì để Redo'); return; }
        this.undoStack.push(e);
        this.restoreEntry(e, 'redo');
        toast('Redo: ' + e.label);
    },/* ---------------- panel UI ---------------- */
    render() {
        const setCls = (id, on, onCls, offCls) => {
            const el = document.getElementById(id);
            if (el) el.className = on ? onCls : offCls;
        };
        const BTN_ON = 'px-2 py-1 rounded bg-purple-600 text-white text-[11px]';
        const BTN_OFF = 'px-2 py-1 rounded bg-slate-200 text-slate-700 text-[11px]';
        setCls('btn-toggle-ik', this.ikOn, BTN_ON, BTN_OFF);
        setCls('btn-toggle-onion', this.onion.on, BTN_ON, BTN_OFF);
        const b = this.selected();
        setCls('btn-toggle-lock', !!(b && this.lock.has(b.name)), 'px-2 py-1 rounded bg-red-600 text-white text-[11px]', BTN_OFF);
        setCls('btn-toggle-hide', !!(b && this.hidden.has(b.name)), 'px-2 py-1 rounded bg-red-600 text-white text-[11px]', BTN_OFF);
        // hiển thị bone đang chọn + clip hiện tại
        const info = document.getElementById('rig-adv-info');
        if (info) {
            const c = Engine.animation.currentClip;
            info.textContent = `bone: ${b ? b.name : '—'} · clip: ${c ? c.name : '—'} · speed: ${this.speed}x · undo: ${this.undoStack.length}`;
        }
        if (b) this.fillBoneInputs(b.name);
    },

    init() {
        if (this.ready) return;
        if (typeof Engine === 'undefined' || !Engine.scene) return;
        this.ready = true;
        this.loadSlots();
        this.setupViewportInteraction();
        this.bindTimeline();
        // ticker: IK + ghost + playhead + overlay mỗi frame (sau scene.update)
        this.scene().app.ticker.add(() => {
            try {
                if (this.ikOn) {
                    this.solveIK();
                    SpineRig.syncBoneContainers(this.skel());
                }
                if (this.onion.on) this.drawGhosts();
                this.drawOverlay();
                this.drawPlayhead();
            } catch (e) { /* không để lỗi overlay làm chết ticker */ }
        });
        // giữ state UI khớp khi đổi bone/clip
        const origSelect = Engine.selectBone.bind(Engine);
        Engine.selectBone = (n) => { origSelect(n); this.render(); };
        console.log('[RigAdvanced] ready — 15 công cụ rig nâng cao');
    },

    /** trả về mô tả 15 tính năng (dùng cho chat/README) */
    list() {
        return [
            '1 Kéo-xoay bone trong viewport (Alt/Shift = di chuyển)',
            '2 IK 2 xương cho chân (bật/tắt + kéo target)',
            '3 Tạo / nhân bản / xoá / đổi cha bone',
            '4 Sửa thuộc tính bone: x, y, rotation, length, scale, inherit',
            '5 Khoá & ẩn bone',
            '6 Đối xứng hoá bộ xương L↔R',
            '7 Copy / dán / lật pose',
            '8 Undo / Redo (Ctrl+Z / Ctrl+Shift+Z)',
            '9 Thư viện pose 6 slot (localStorage)',
            '10 Nội suy key: linear / ease / easeIn / easeOut / easeInOut / step',
            '11 Thêm key tại playhead / xoá key / kéo key đổi thời gian',
            '12 Tua timeline (scrub) + tốc độ phát 0.1x–4x',
            '13 Quản lý clip: tạo / nhân bản / đổi tên / xoá / duration',
            '14 Onion skin xương khung trước & sau',
            '15 Sinh phụ diễn tự động (tóc / vạt áo / vũ khí trễ pha)'
        ];
    }
};

window.RigAdvanced = RigAdvanced;

/* khởi động khi engine đã boot xong */
(function boot() {
    let n = 0;
    const tick = () => {
        n++;
        if (typeof Engine !== 'undefined' && Engine.scene && Engine.app) { RigAdvanced.init(); return; }
        if (n < 300) setTimeout(tick, 100);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
})();/* =====================================================================
   TIMELINE OVERLAY — nút kéo key + hook sau khi engine render dopesheet
   ===================================================================== */
Object.assign(RigAdvanced, {
    /** gọi ở cuối renderDopesheet(): vẽ lại playhead + tay nắm key */
    afterTimelineRender() {
        if (!this.ready) return;
        const layer = document.getElementById('dopesheet-keyframes-layer');
        if (!layer) return;
        const clip = Engine.animation.currentClip;
        if (!clip) return;
        layer.querySelectorAll('.rig-key').forEach(n => n.remove());
        // mỗi track 1 hàng cao 24px (giống renderDopesheet của engine)
        clip.tracks.forEach((tr, row) => {
            (tr.keys || []).forEach((k, i) => {
                const el = document.createElement('div');
                el.className = 'rig-key';
                el.title = `${tr.bone} @ ${k.t}s${k.ease && k.ease !== 'linear' ? ' · ' + k.ease : ''}`;
                el.style.cssText = `position:absolute;left:${Math.max(0, Math.min(100, (k.t / clip.duration) * 100))}%;top:${row * 24 + 8}px;` +
                    `width:9px;height:9px;transform:translate(-50%,0);border-radius:2px;cursor:ew-resize;z-index:4;` +
                    `background:${k.ease && k.ease !== 'linear' ? '#a855f7' : '#0ea5e9'};box-shadow:0 0 0 1px #fff`;
                el.addEventListener('pointerdown', ev => {
                    ev.stopPropagation();
                    this._keyDrag = { bone: tr.bone, i };
                    this.markTimeline();
                });
                el.addEventListener('pointerup', () => {
                    if (this._keyDrag) { this.commitTimeline('kéo key'); this._keyDrag = null; }
                });
                layer.appendChild(el);
            });
        });
        this.drawPlayhead();
    }
});