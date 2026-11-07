/* =====================================================================
   ANIM AI — 15 tính năng AI nâng cao cho ANIMATION
   ---------------------------------------------------------------------
   Nạp SAU pixijs_v8_engine_openai_api.js (dùng chung scope global).

   1  Sinh clip bằng AI theo mô tả (tự chọn model đang gọi được)
   2  Tạo bộ clip nhân vật đầy đủ (idle/walk/run/attack/hit/jump/death)
   3  AI diễn lại clip hiện có mượt/hay hơn (pro pass)
   4  Tách nhịp & chú thích clip (anticipation/action/follow-through/settle)
   5  Đồng bộ thoại/lời với animation (lip-sync theo viseme)
   6  Sinh keyframe giữa 2 key (in-between)
   7  Tạo biến thể clip (nhanh/chậm/mạnh/nhẹ/ngẫu nhiên)
   8  Phân tích chất lượng clip + tự sửa (loop, ease, biên độ)
   9  AI đạo diễn chuyển clip + state machine
   10 Blend/trộn 2 clip với trọng số
   11 Thư viện clip + import/export JSON
   12 Tái thời gian (time-remap) & đổi tốc độ theo đoạn
   13 Sinh biểu cảm khuôn mặt (mắt/lông mày/miệng)
   14 Sinh chuyển động phụ trợ (áo choàng/tóc/vũ khí) tự động
   15 Vòng lặp tự cải thiện: chấm điểm → sửa → chấm lại
   ===================================================================== */

const AnimAI = {
    ready: false,
    clips: [],            // thư viện clip tự tạo
    lastReport: null,
    _busy: false,

    /* ---------------- tiện ích ---------------- */
    a() { return (typeof Engine !== 'undefined' && Engine.animation) || null; },
    skel() { const s = Engine.scene; return (s && s.spine) || null; },
    clip() { const a = this.a(); return a && a.currentClip; },
    curves() { return Engine.curves || null; },

    toastN(m) { toast(m); },
    setBusy(on) { this._busy = on; this.render(); },

    /** gọi model đang được chọn qua /api/chat (proxy .env), trả về text */
    async ask(prompt) {
        const p = (currentModelConfig && currentModelConfig.provider) || 'agentrouter';
        const model = (currentModelConfig && currentModelConfig.model) || 'gpt-5.6-sol';
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: p,
                model,
                allowedModels: true,
                reasoningEffort: 'minimal',
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            throw new Error(String(e.error || ('HTTP ' + res.status)));
        }
        const d = await res.json();
        const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
        return (m.content || '').trim();
    },/** mô tả rig để AI chỉ dùng tên bone hợp lệ */
    rigBrief() {
        const sk = this.skel();
        const bones = sk ? sk.ordered.map(b => b.name) : [];
        const parts = (typeof PartAtlas !== 'undefined' && PartAtlas.list) ? PartAtlas.list() : [];
        return `BONES: ${bones.join(', ')}\nPARTS: ${parts.join(', ')}`;
    },

    /** trích JSON clip từ trả lời AI (chấp nhận ```json hoặc object trần) */
    parseClips(text) {
        const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
        const cands = blocks.length ? blocks : [text];
        for (const c of cands) {
            try {
                const js = parseAIJSON(c);
                if (js && Array.isArray(js.clips) && js.clips.length) return js.clips;
                if (Array.isArray(js)) return js;
            } catch (e) { /* thử block kế */ }
        }
        return null;
    },

    /** áp clip vào engine (giữ clip cũ, ghi đè theo id) */
    install(clips, opts) {
        const a = this.a();
        if (!a || !clips || !clips.length) { toast('Không có clip hợp lệ'); return 0; }
        const good = sanitizeClips(clips);
        if (!good.length) { toast('Clip bị loại (tên bone không khớp skeleton)'); return 0; }
        /* sanitizeClips() tạo object MỚI → copy lại các field phụ (phases, ...)
           từ clip gốc cùng id để không mất dữ liệu nhịp đã chú thích. */
        good.forEach(cl => {
            const src = clips.find(x => x && x.id === cl.id);
            if (src && Array.isArray(src.phases)) cl.phases = src.phases;
        });
        const map = new Map(a.clips.map(c => [c.id, c]));
        good.forEach(c => map.set(c.id, c));
        a.loadClips([...map.values()], true);
        const last = good[good.length - 1];
        a.setCurrent(last.id);
        togglePlayState(true);
        this.pushClips(good.map(c => c.id));
        renderDopesheet(); updateClipHUD(); this.render();
        if (!(opts && opts.silent)) {
            addChatMessage('assistant', '🎬 **AI animation**: ' +
                good.map(c => `\`${c.id}\` ${c.name} ${c.duration}s × ${c.tracks.length} tracks`).join(' · '));
        }
        return good.length;
    },

    pushClips(ids) { ids.forEach(id => { if (!this.clips.includes(id)) this.clips.push(id); }); saveLibrary(this.clips); },

    /* ================= 1. sinh clip theo mô tả ================= */
    async genFromPrompt(desc) {
        const d = (desc || (document.getElementById('anim-ai-prompt') || {}).value || '').trim();
        if (!d) { toast('Nhập mô tả chuyển động trước'); return; }
        this.setBusy(true);
        setStatus('AI đang sinh chuyển động...');
        try {
            const prompt = [
                'You are a 2D skeletal animation expert (Spine style).',
                this.rigBrief(),
                'Y axis points DOWN. rotation = degrees, positive = clockwise.',
                '',
                'TASK: ' + d,
                'Output ONLY compact JSON, no prose:',
                '{"clips":[{"id":"clip_id","name":"Tên","duration":1.0,"tracks":[{"bone":"arm_upper_R","keys":[{"t":0,"rotation":0},{"t":0.3,"rotation":-80},{"t":1.0,"rotation":0}]}',
                'Rules: every track starts and ends at rotation 0 (clean loop); 4-6 keys per track;',
                'use anticipation → action → follow-through → settle; add secondary motion for hair/weapon bones.',
                'Use ONLY bone names from BONES above. Keep the JSON under 1800 characters.'
            ].join('\n');
            const out = await this.ask(prompt);
            const clips = this.parseClips(out);
            if (!clips) { addChatMessage('assistant', '⚠️ AI không trả JSON clip hợp lệ:\n\n' + out.slice(0, 400)); return; }
            const n = this.install(clips);
            setStatus(`AI animation: +${n} clip`);
        } catch (e) {
            addChatMessage('assistant', '⚠️ **AI animation lỗi**: ' + e.message);
        } finally { this.setBusy(false); }
    },/* ================= 2. bộ clip nhân vật đầy đủ ================= */
    async genFullSet(style) {
        const s = (style || (document.getElementById('anim-ai-style') || {}).value || 'cartoon action');
        this.setBusy(true);
        setStatus('AI đang sinh bộ clip đầy đủ...');
        try {
            const prompt = [
                'You are a 2D skeletal animation expert (Spine style). Style: ' + s + '.',
                this.rigBrief(),
                'Y axis points DOWN, rotation in degrees (positive = clockwise).',
                '',
                'Output ONLY compact JSON: {"clips":[ ... ]} with EXACTLY these 7 clips:',
                'idle (2.4s), walk (1.2s), run (0.8s), attack (1.0s), hit (0.5s), jump (0.9s), death (1.4s).',
                'Each clip: 4-6 tracks, 4-5 keys per track, every track starts AND ends at rotation 0',
                '(except death, which may end non-zero). Include anticipation/follow-through and',
                'secondary motion on hair/weapon/skirt bones. Use ONLY bone names from BONES.',
                'Keep the whole JSON under 3500 characters.'
            ].join('\n');
            const out = await this.ask(prompt);
            const clips = this.parseClips(out);
            if (!clips) { addChatMessage('assistant', '⚠️ AI không trả bộ clip hợp lệ:\n\n' + out.slice(0, 400)); return; }
            const n = this.install(clips);
            setStatus(`AI full set: +${n} clip`);
        } catch (e) {
            addChatMessage('assistant', '⚠️ **Lỗi sinh bộ clip**: ' + e.message);
        } finally { this.setBusy(false); }
    },

    /* ================= 3. AI diễn lại clip cho mượt/hay hơn ================= */
    async proPass() {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        this.setBusy(true);
        setStatus('AI đang trau chuốt lại clip...');
        try {
            const prompt = [
                'You are a senior 2D animation director (Spine style).',
                this.rigBrief(),
                'Current clip JSON:',
                JSON.stringify({ clips: [c] }).slice(0, 2600),
                '',
                'Rewrite this clip for better timing & weight: stronger anticipation, snappier action',
                '(1-2 frames), follow-through/overshoot, settle; add overlapping action on hair/weapon;',
                'arcs on limbs. Keep the same id and duration (or slightly better duration), 4-6 keys per track,',
                'every track starts and ends at rotation 0. Output ONLY {"clips":[ ... ]} JSON, no prose.'
            ].join('\n');
            const out = await this.ask(prompt);
            const clips = this.parseClips(out);
            if (!clips) { addChatMessage('assistant', '⚠️ AI không trả clip hợp lệ:\n\n' + out.slice(0, 400)); return; }
            const n = this.install(clips);
            setStatus(`AI pro pass: ${n} clip`);
        } catch (e) {
            addChatMessage('assistant', '⚠️ **Lỗi pro pass**: ' + e.message);
        } finally { this.setBusy(false); }
    },

    /* ================= 4. chú thích nhịp clip ================= */
    annotateClip() {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        // suy ra pha từ tổng "năng lượng" chuyển động theo thời gian
        const dur = c.duration || 1;
        const step = dur / 24;
        let best = { t: 0, v: -1 }, prev = c.tracks.map(() => 0);
        const samples = [];
        for (let t = 0; t <= dur + 1e-6; t += step) {
            let v = 0;
            c.tracks.forEach((tr, i) => {
                const s = sampleTrack(tr.keys, t);
                const d = Math.abs(s.rotation - prev[i]);
                v += d; prev[i] = s.rotation;
            });
            samples.push({ t: +t.toFixed(3), v });
            if (v > best.v) best = { t: +t.toFixed(3), v };
        }
        const maxV = Math.max(...samples.map(s => s.v), 0.001);
        const norm = samples.map(s => ({ t: s.t, p: s.v / maxV }));
        const cut = norm.find(s => s.p > 0.12) || { t: 0 };
        const action = best.t;
        const follow = norm.filter(s => s.t > action && s.p < 0.25)[0] || { t: Math.min(dur, action + step * 3) };
        const phases = [
            { name: 'anticipation (lấy đà)', from: cut.t, to: action },
            { name: 'action (nhịp nhanh nhất)', at: action },
            { name: 'follow-through (quá đà)', from: action, to: follow.t },
            { name: 'settle (về 0)', from: follow.t, to: dur }
        ];
        c.phases = phases;
        this.install([c], { silent: true });
        // install() chạy sanitizeClips (tạo object mới) → gán lại phases lên clip đang phát
        const live = this.clip();
        if (live) live.phases = phases;
        renderDopesheet();
        addChatMessage('assistant',
            `📝 **Nhịp của clip \`${c.id}\`** (${dur}s)\n\n` +
            `- lấy đà: 0 → ${action.toFixed(2)}s\n- nhịp chính (đỉnh nhanh nhất): **${action.toFixed(2)}s**\n` +
            `- quá đà: ${action.toFixed(2)} → ${follow.t.toFixed(2)}s\n- dừng lại: ${follow.t.toFixed(2)} → ${dur.toFixed(2)}s\n` +
            'Vùng nhịp được lưu vào clip và tô trên timeline.');
        this.drawPhaseBands();
    },

    /* ================= 5. đồng bộ thoại / lip-sync ================= */
    async lipSync() {
        const c = this.clip();
        const text = (document.getElementById('anim-ai-line') || {}).value || '';
        if (!c) { toast('Chưa có clip'); return; }
        if (!text.trim()) { toast('Nhập câu thoại trước'); return; }
        this.setBusy(true);
        setStatus('AI đang chia viseme cho thoại...');
        try {
            const prompt = [
                'Split this spoken line into mouth-shape (viseme) beats for a 2D character.',
                'Sentence: "' + text.replace(/"/g, "'") + '"',
                '',
                'Output ONLY compact JSON: {"visemes":[{"char":"A","mouth":0.8},{"char":"I","mouth":0.35}, ...]}',
                'Use mouth in 0..1 (0 closed, 1 wide open). One entry per character, skip spaces.',
                'Keep under 1500 characters.'
            ].join('\n');
            const out = await this.ask(prompt);
            let vis = null;
            const m = out.match(/\{[\s\S]*\}/);
            if (m) { try { vis = JSON.parse(m[0]).visemes; } catch (e) { } }
            if (!vis || !vis.length) { addChatMessage('assistant', '⚠️ AI không trả viseme hợp lệ:\n\n' + out.slice(0, 300)); return; }
            this.applyVisemes(vis, c);
            setStatus(`Lip-sync: ${vis.length} viseme → track mouth`);
        } catch (e) {
            addChatMessage('assistant', '⚠️ **Lỗi lip-sync**: ' + e.message);
        } finally { this.setBusy(false); }
    },

    /** viseme → track scale cho bone mặt (mouth) */
    applyVisemes(vis, clip) {
        const sk = this.skel();
        if (!sk) return;
        const cands = sk.ordered.map(b => b.name).filter(n => /mouth|jaw|face|head/i.test(n));
        const bone = cands.find(n => /mouth|jaw/i.test(n)) || cands[0];
        if (!bone) { toast('Rig không có bone miệng/mặt'); return; }
        const dur = clip.duration || 1;
        const step = dur / Math.max(1, vis.length);
        const keys = vis.map((v, i) => ({
            t: +(i * step).toFixed(3),
            x: 0, y: 0, rotation: 0,
            scale: 1 + 0.35 * Math.max(0, Math.min(1, +v.mouth || 0)),
            ease: 'ease'
        }));
        keys.push({ t: +dur.toFixed(3), x: 0, y: 0, rotation: 0, scale: 1, ease: 'linear' });
        let tr = clip.tracks.find(t => t.bone === bone);
        if (!tr) { tr = { bone, keys }; clip.tracks.push(tr); } else tr.keys = keys;
        this.install([clip], { silent: true });
        addChatMessage('assistant', `👄 **Lip-sync**: ${vis.length} viseme → track \`${bone}\` (scale miệng) trong clip \`${clip.id}\`.`);
    },

    /* ================= 6. sinh keyframe giữa 2 key ================= */
    async interpolateBetween() {
        const c = this.clip();
        const bone = Engine.selectedBone;
        if (!c) { toast('Chưa có clip'); return; }
        if (!bone) { toast('Chọn bone trước'); return; }
        const tr = c.tracks.find(t => t.bone === bone);
        if (!tr || tr.keys.length < 2) { toast('Track này cần ≥2 key'); return; }
        const t0 = tr.keys[0], t1 = tr.keys[tr.keys.length - 1];
        this.setBusy(true);
        try {
            const prompt = [
                'Add ONE in-between key in the middle of this animation segment (2D skeletal, rotation degrees).',
                `Bone: ${bone}. Duration ${c.duration}s. Start key: ${JSON.stringify(t0)} End key: ${JSON.stringify(t1)}`,
                'Insert 2 intermediate keys that follow a natural arc with follow-through (not a straight lerp).',
                'Output ONLY: {"keys":[{"t":..,"rotation":..,"x":..,"y":..,"scale":..}, ...]} — only the NEW keys, sorted by t.',
                't must be strictly between the start and end times.'
            ].join('\n');
            const out = await this.ask(prompt);
            const m = out.match(/\{[\s\S]*\}/);
            let keys = null;
            if (m) { try { keys = JSON.parse(m[0]).keys; } catch (e) { } }
            if (!keys || !keys.length) { addChatMessage('assistant', '⚠️ AI không trả key hợp lệ:\n\n' + out.slice(0, 300)); return; }
            const tmin = Math.min(t0.t, t1.t), tmax = Math.max(t0.t, t1.t);
            keys.forEach(k => {
                const t = +k.t;
                if (!isFinite(t) || t <= tmin || t >= tmax) return;
                tr.keys = tr.keys.filter(x => Math.abs(x.t - t) > 0.01);
                tr.keys.push({ t: +t.toFixed(3), x: +k.x || 0, y: +k.y || 0, rotation: +k.rotation || 0, scale: +k.scale || 1, ease: 'ease' });
            });
            tr.keys.sort((a, b) => a.t - b.t);
            this.install([c], { silent: true });
            addChatMessage('assistant', `➕ Đã chèn **${keys.length} key in-between** cho \`${bone}\`.`);
        } catch (e) {
            addChatMessage('assistant', '⚠️ **Lỗi in-between**: ' + e.message);
        } finally { this.setBusy(false); }
    },/* ================= 7. biến thể clip (nhanh/chậm/mạnh/nhẹ/ngẫu nhiên) ================= */
    makeVariant(kind) {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        const k = (kind || 'strong').toLowerCase();
        const clone = JSON.parse(JSON.stringify(c));
        let id = c.id, name = c.name;
        clone.tracks.forEach(tr => {
            tr.keys.forEach(key => {
                if (key.rotation !== undefined) key.rotation = +(key.rotation * (k === 'strong' ? 1.35 : k === 'soft' ? 0.7 : 1)).toFixed(2);
                if (k === 'fast') key.t = +(key.t / 1.5).toFixed(3);
                if (k === 'slow') key.t = +(key.t * 1.5).toFixed(3);
                if (key.y !== undefined) key.y = +(key.y * (k === 'strong' ? 1.3 : 1)).toFixed(2);
            });
            tr.keys.sort((a, b) => a.t - b.t);
        });
        if (k === 'fast') clone.duration = +(c.duration / 1.5).toFixed(2);
        if (k === 'slow') clone.duration = +(c.duration * 1.5).toFixed(2);
        clone.id = id + '_' + k;
        clone.name = name + ' · ' + k;
        this.install([clone], { silent: true });
        addChatMessage('assistant', `🧬 Tạo biến thể **${k}**: \`${clone.id}\` (${clone.duration}s)`);
    },

    /* ================= 8. phân tích chất lượng + tự sửa ================= */
    analyzeClip(fix) {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        const issues = [];
        const dur = c.duration || 1;
        let keyCount = 0;
        const bad = c.tracks.filter(t => t.bone && !this.skel().bones.has(t.bone));
        if (bad.length) issues.push(`Có ${bad.length} track trỏ tới bone không tồn tại (sẽ bị loại).`);
        c.tracks.forEach(tr => {
            const ks = tr.keys || [];
            keyCount += ks.length;
            if (ks.length < 2) issues.push(`Track \`${tr.bone}\` chỉ có ${ks.length} key.`);
            const loop = ks.length >= 2 && Math.abs((ks[0].rotation || 0) - (ks[ks.length - 1].rotation || 0)) > 1.5;
            if (loop) issues.push(`Track \`${tr.bone}\` không loop sạch (đầu/cuối lệch ${Math.abs((ks[0].rotation || 0) - (ks[ks.length - 1].rotation || 0)).toFixed(1)}°).`);
            const hasEase = ks.some(k => k.ease && k.ease !== 'linear');
            if (!hasEase) issues.push(`Track \`${tr.bone}\` chỉ dùng linear (thiếu ease để mượt).`);
            const last = ks[ks.length - 1];
            if (last && last.t > dur + 0.001) issues.push(`Track \`${tr.bone}\` có key vượt duration.`);
        });
        const score = Math.max(0, 100 - issues.length * 6);
        this.lastReport = { score, issues, keyCount, tracks: c.tracks.length };
        addChatMessage('assistant',
            `🔎 **Chấm điểm clip \`${c.id}\`**: **${score}/100**\n\n` +
            `- ${c.tracks.length} tracks · ${keyCount} keys · ${dur}s\n` +
            (issues.length ? issues.map(i => '- ' + i).join('\n') : '- Không phát hiện lỗi rõ ràng.'));
        if (fix) { this.autoFix(); }
        this.render();
    },

    /** tự sửa: kẹp key về duration, ease mặc định, đóng loop về 0 */
    autoFix() {
        const c = this.clip();
        if (!c) return;
        const dur = c.duration || 1;
        const sk = this.skel();
        c.tracks = c.tracks.filter(t => !sk || sk.bones.has(t.bone));
        c.tracks.forEach(tr => {
            if (!tr.keys || !tr.keys.length) return;
            tr.keys = tr.keys.filter(k => isFinite(k.t) && k.t <= dur + 0.001)
                .map(k => ({ ...k, ease: k.ease || 'ease' }))
                .sort((a, b) => a.t - b.t);
            const first = tr.keys[0], last = tr.keys[tr.keys.length - 1];
            if (first && last) {
                first.t = 0;
                last.t = +dur.toFixed(3);
                last.x = first.x || 0; last.y = first.y || 0;
                last.rotation = first.rotation || 0; last.scale = first.scale ?? 1;
            }
        });
        this.install([c], { silent: true });
        toast('Đã tự sửa clip (loop, ease, kẹp duration)');
    },/* ================= 9. AI đạo diễn chuyển clip (state machine) ================= */
    async genTransitions() {
        const a = this.a();
        if (!a || a.clips.length < 2) { toast('Cần ≥2 clip để tạo chuyển cảnh'); return; }
        this.setBusy(true);
        try {
            const brief = a.clips.map(c => `${c.id} (${c.duration}s, ${c.tracks.length} tracks)`).join(', ');
            const prompt = [
                'You are an animation director for a 2D game character.',
                this.rigBrief(),
                'Existing clips: ' + brief,
                '',
                'Design a state machine: which clip plays after which, plus a blend time.',
                'Output ONLY compact JSON:',
                '{"states":[{"from":"idle","to":"attack","when":"player presses attack","blend":0.12}],',
                ' "default":"idle"}',
                'Only use clip ids from the list. 5-10 transitions. No prose.'
            ].join('\n');
            const out = await this.ask(prompt);
            const m = out.match(/\{[\s\S]*\}/);
            if (!m) { addChatMessage('assistant', '⚠️ AI không trả state machine:\n\n' + out.slice(0, 300)); return; }
            let js;
            try { js = JSON.parse(m[0]); } catch (e) { toast('JSON lỗi'); return; }
            this.sm = js;
            Engine.stateMachine = js;
            addChatMessage('assistant', '🎛️ **State machine** (AI đạo diễn)\n\n' +
                (js.states || []).map(s => `- \`${s.from}\` → \`${s.to}\` · ${s.blend || 0.1}s — ${s.when || ''}`).join('\n') +
                `\n\nMặc định: \`${js.default || (a.clips[0] && a.clips[0].id)}\``);
            this.render();
        } catch (e) {
            addChatMessage('assistant', '⚠️ **Lỗi state machine**: ' + e.message);
        } finally { this.setBusy(false); }
    },

    /** chạy thử state machine: chuyển clip theo thời gian với blend */
    playStateMachine(seconds) {
        const js = this.sm || Engine.stateMachine;
        const a = this.a();
        if (!js || !a) { toast('Chưa có state machine'); return; }
        const seq = [js.default || a.clips[0].id,
            ...(js.states || []).map(s => s.to).filter(Boolean)];
        let i = 0;
        const step = () => {
            if (i >= seq.length) { toast('Đã chạy xong state machine'); return; }
            const id = seq[i++];
            if (a.clips.some(c => c.id === id)) a.setCurrent(id);
            setStatus('State machine: ' + id);
            setTimeout(step, (seconds || 1.2) * 1000);
        };
        step();
    },

    /* ================= 10. blend 2 clip ================= */
    blendClips(idA, idB, w) {
        const a = this.a();
        if (!a) return;
        const A = a.clips.find(c => c.id === idA), B = a.clips.find(c => c.id === idB);
        if (!A || !B) { toast('Chọn 2 clip để blend'); return; }
        const t = Math.max(0, Math.min(1, +w || 0.5));
        const dur = Math.max(A.duration, B.duration);
        const bones = new Set([...A.tracks.map(x => x.bone), ...B.tracks.map(x => x.bone)]);
        const tracks = [];
        bones.forEach(bone => {
            const ta = A.tracks.find(x => x.bone === bone), tb = B.tracks.find(x => x.bone === bone);
            const keys = [];
            const N = 10;
            for (let i = 0; i <= N; i++) {
                const tt = +(dur * i / N).toFixed(3);
                const sa = ta ? sampleTrack(ta.keys, tt) : { x: 0, y: 0, rotation: 0, scale: 1 };
                const sb = tb ? sampleTrack(tb.keys, tt) : { x: 0, y: 0, rotation: 0, scale: 1 };
                keys.push({
                    t: tt,
                    x: +(sa.x * (1 - t) + sb.x * t).toFixed(3),
                    y: +(sa.y * (1 - t) + sb.y * t).toFixed(3),
                    rotation: +(sa.rotation * (1 - t) + sb.rotation * t).toFixed(3),
                    scale: +((sa.scale ?? 1) * (1 - t) + (sb.scale ?? 1) * t).toFixed(3),
                    ease: 'linear'
                });
            }
            tracks.push({ bone, keys });
        });
        const clip = { id: `${A.id}_x_${B.id}_${Math.round(t * 100)}`, name: `${A.name} ↔ ${B.name} (${Math.round(t * 100)}%)`, duration: +dur.toFixed(2), tracks };
        this.install([clip], { silent: true });
        addChatMessage('assistant', `🔀 Blend \`${A.id}\` + \`${B.id}\` với trọng số ${Math.round(t * 100)}% → \`${clip.id}\`.`);
    },/* ================= 11. thư viện clip + import/export ================= */
    exportLibrary() {
        const a = this.a();
        const data = { kind: 'rigstudio-clips', at: new Date().toISOString(), clips: (a && a.clips) || [] };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const el = document.createElement('a');
        el.href = URL.createObjectURL(blob);
        el.download = 'rigstudio_clips.json';
        document.body.appendChild(el); el.click(); el.remove();
        toast('Đã export ' + (data.clips.length) + ' clip');
    },

    importLibrary() {
        const inp = document.getElementById('anim-ai-file');
        if (inp) { inp.value = ''; inp.click(); }
    },

    async onImportFile(file) {
        if (!file) return;
        try {
            const js = JSON.parse(await file.text());
            const clips = Array.isArray(js) ? js : (js.clips || []);
            const n = this.install(clips);
            toast('Đã import ' + n + ' clip');
        } catch (e) { toast('File JSON lỗi: ' + e.message); }
    },

    /** lưu/đọc danh sách clip đã tạo vào localStorage */
    saveLib() {
        try { localStorage.setItem('pixi_anim_lib', JSON.stringify(this.clips)); } catch (e) { }
    },
    loadLib() {
        try { const s = localStorage.getItem('pixi_anim_lib'); this.clips = s ? JSON.parse(s) : []; } catch (e) { this.clips = []; }
    },/* ================= 12. time-remap / đổi tốc độ theo đoạn ================= */
    timeRemap(speed, from, to) {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        const d = c.duration || 1;
        const t0 = Math.max(0, Math.min(d, from === undefined ? 0 : +from));
        const t1 = Math.max(t0 + 0.001, Math.min(d, to === undefined ? d : +to));
        const s = Math.max(0.1, Math.min(4, +speed || 1));
        c.tracks.forEach(tr => {
            tr.keys = tr.keys.map(k => {
                if (k.t >= t0 && k.t <= t1) {
                    const nt = t0 + (k.t - t0) / s;
                    return { ...k, t: +Math.min(d, nt).toFixed(3) };
                }
                return k;
            }).sort((a, b) => a.t - b.t);
        });
        this.install([c], { silent: true });
        toast(`Time-remap ${t0}s→${t1}s @ ${s}x`);
    },

    /* ================= 13. biểu cảm khuôn mặt ================= */
    async genExpression(expr) {
        const c = this.clip();
        const sk = this.skel();
        if (!c || !sk) { toast('Chưa có clip/skeleton'); return; }
        const faceBones = sk.ordered.map(b => b.name).filter(n => /eye|mouth|brow|face|head|jaw/i.test(n));
        if (!faceBones.length) { toast('Rig không có bone mặt (eye/mouth/brow)'); return; }
        const e = (expr || (document.getElementById('anim-ai-expr') || {}).value || 'vui vẻ').trim();
        this.setBusy(true);
        try {
            const prompt = [
                'Animate the FACE of a 2D cartoon character for this expression: "' + e + '".',
                'Available face bones: ' + faceBones.join(', '),
                'Clip duration: ' + c.duration + 's. y down, rotation degrees.',
                'Output ONLY compact JSON: {"clips":[{ "id":"' + c.id + '_face", "name":"' + e + '", "duration":' + c.duration + ',',
                '"tracks":[{"bone":"eye_L","keys":[{"t":0,"rotation":0},{"t":0.5,"rotation":-8},{"t":' + c.duration + ',"rotation":0}]}]}]}',
                'Use subtle values (±3..15°) and start/end at 0. No prose.'
            ].join('\n');
            const out = await this.ask(prompt);
            const clips = this.parseClips(out);
            if (!clips) { addChatMessage('assistant', '⚠️ AI không trả biểu cảm hợp lệ:\n\n' + out.slice(0, 300)); return; }
            const n = this.install(clips, { silent: true });
            addChatMessage('assistant', `😀 **Biểu cảm "${e}"**: +${n} clip mặt (${faceBones.length} bone mặt khả dụng).`);
        } catch (err) {
            addChatMessage('assistant', '⚠️ **Lỗi biểu cảm**: ' + err.message);
        } finally { this.setBusy(false); }
    },/* ================= 14. chuyển động phụ trợ tự động ================= */
    genSecondary() {
        const c = this.clip();
        const sk = this.skel();
        if (!c || !sk) { toast('Chưa có clip/skeleton'); return; }
        const driver = c.tracks.find(t => /torso|hips|spine/i.test(t.bone)) || c.tracks[0];
        if (!driver) { toast('Clip chưa có track thân'); return; }
        const targets = sk.ordered.map(b => b.name)
            .filter(n => /hair|cape|cloak|skirt|loincloth|belt|tail|beard|sleeve|weapon|sword/i.test(n));
        if (!targets.length) { toast('Không có bone phụ (hair/cape/weapon)'); return; }
        let n = 0;
        targets.forEach((name, i) => {
            if (name === driver.bone) return;
            const lag = 0.07 + i * 0.015;
            const amp = 0.6 / (1 + i * 0.2);
            const keys = [];
            const N = 10, dur = c.duration || 1;
            for (let k = 0; k <= N; k++) {
                const t = dur * k / N;
                const s = sampleTrack(driver.keys, Math.max(0, t - lag));
                keys.push({
                    t: +t.toFixed(3),
                    x: +(s.x * amp).toFixed(3), y: +(s.y * amp).toFixed(3),
                    rotation: +(s.rotation * amp).toFixed(3), scale: 1, ease: 'ease'
                });
            }
            keys[keys.length - 1].x = keys[0].x;
            keys[keys.length - 1].y = keys[0].y;
            keys[keys.length - 1].rotation = keys[0].rotation;
            let tr = c.tracks.find(x => x.bone === name);
            if (!tr) { tr = { bone: name, keys }; c.tracks.push(tr); } else { tr.keys = keys; }
            n++;
        });
        this.install([c], { silent: true });
        addChatMessage('assistant', `🌬️ **Phụ trợ**: thêm/cập nhật ${n} track trễ pha cho tóc/áo/vũ khí trong clip \`${c.id}\`.`);
    },

    /* ================= 15. vòng tự cải thiện ================= */
    async selfImprove(rounds) {
        const c = this.clip();
        if (!c) { toast('Chưa có clip'); return; }
        const R = Math.max(1, Math.min(4, +rounds || 2));
        let best = JSON.parse(JSON.stringify(c));
        let bestScore = this.scoreOf(best);
        for (let r = 1; r <= R; r++) {
            setStatus(`Tự cải thiện ${r}/${R} — điểm hiện tại ${bestScore}`);
            this.install([best], { silent: true });
            await this.proPass();
            const cur = this.clip();
            if (!cur) break;
            const sc = this.scoreOf(cur);
            addChatMessage('assistant', `🔁 Vòng ${r}: điểm ${sc}/100`);
            if (sc >= bestScore) { bestScore = sc; best = JSON.parse(JSON.stringify(cur)); }
            else break;
        }
        this.install([best], { silent: true });
        addChatMessage('assistant', `✅ **Tự cải thiện xong**: clip \`${best.id}\` đạt **${bestScore}/100**.`);
        setStatus('Tự cải thiện xong — ' + bestScore + '/100');
    },

    scoreOf(clip) {
        if (!clip) return 0;
        let s = 100;
        const dur = clip.duration || 1;
        clip.tracks.forEach(tr => {
            const ks = tr.keys || [];
            if (ks.length < 2) s -= 8;
            if (ks.length >= 2) {
                const drift = Math.abs((ks[0].rotation || 0) - (ks[ks.length - 1].rotation || 0));
                if (drift > 1.5) s -= 6;
            }
            if (!ks.some(k => k.ease && k.ease !== 'linear')) s -= 4;
            if (ks.some(k => k.t > dur + 0.001)) s -= 5;
        });
        return Math.max(0, Math.min(100, s));
    },/* ================= UI: panel + timeline phụ ================= */
    render() {
        const info = document.getElementById('anim-ai-info');
        if (info) {
            const c = this.clip();
            info.textContent = `clip: ${c ? c.id : '—'} · ${c ? c.tracks.length : 0} tracks · ` +
                `${this.lastReport ? 'điểm ' + this.lastReport.score + '/100' : 'chưa chấm'} · ` +
                `${this._busy ? 'AI đang chạy…' : (this.sm ? 'state machine ✓' : 'sẵn sàng')}`;
        }
        const btn = document.getElementById('btn-anim-ai-run');
        if (btn) btn.disabled = !!this._busy;
        // select chọn clip để blend
        const selA = document.getElementById('anim-ai-blend-a');
        const selB = document.getElementById('anim-ai-blend-b');
        const a = this.a();
        if (a && (selA || selB)) {
            const opts = a.clips.map(c => `<option value="${c.id}">${c.name} (${c.id})</option>`).join('');
            if (selA && selA.dataset.sig !== opts) { selA.innerHTML = opts; selA.dataset.sig = opts; }
            if (selB && selB.dataset.sig !== opts) { selB.innerHTML = opts; selB.dataset.sig = opts; }
            const cur = this.clip();
            if (cur && selB) selB.value = cur.id;
        }
    },

    /** tô vùng nhịp (anticipation/action/follow/settle) trên timeline */
    drawPhaseBands() {
        const layer = document.getElementById('dopesheet-keyframes-layer');
        const c = this.clip();
        if (!layer) return;
        layer.querySelectorAll('.phase-band').forEach(n => n.remove());
        if (!c || !c.phases) return;
        const dur = c.duration || 1;
        const colors = ['#dbeafe', '#fde68a', '#fecaca', '#dcfce7'];
        c.phases.forEach((p, i) => {
            const from = p.at !== undefined ? p.at : p.from;
            const to = p.at !== undefined ? p.at + 0.02 : p.to;
            const el = document.createElement('div');
            el.className = 'phase-band';
            el.title = p.name;
            el.style.cssText = `position:absolute;left:${(from / dur) * 100}%;width:${Math.max(0.6, ((to - from) / dur) * 100)}%;` +
                `top:0;bottom:0;background:${colors[i % 4]};opacity:.55;pointer-events:none;z-index:1`;
            layer.appendChild(el);
        });
    },

    /** mô tả 15 tính năng */
    list() {
        return [
            '1 Sinh clip bằng AI theo mô tả',
            '2 Bộ clip nhân vật đầy đủ (idle/walk/run/attack/hit/jump/death)',
            '3 AI pro pass — diễn lại clip cho mượt/hay hơn',
            '4 Chú thích nhịp anticipation/action/follow-through/settle',
            '5 Lip-sync theo thoại (viseme)',
            '6 Sinh key in-between giữa 2 key',
            '7 Biến thể clip: fast/slow/strong/soft',
            '8 Chấm điểm chất lượng + tự sửa',
            '9 AI đạo diễn state machine chuyển clip',
            '10 Blend 2 clip theo trọng số',
            '11 Thư viện clip + import/export JSON',
            '12 Time-remap / đổi tốc độ theo đoạn',
            '13 Sinh biểu cảm khuôn mặt',
            '14 Sinh chuyển động phụ trợ (tóc/áo/vũ khí)',
            '15 Vòng tự cải thiện: chấm → sửa → chấm lại'
        ];
    },

    init() {
        if (this.ready) return;
        if (typeof Engine === 'undefined' || !Engine.app) return;
        this.ready = true;
        this.loadLib();
        // hook sau khi vẽ dopesheet: vẽ lại vùng nhịp + cập nhật panel
        const origRender = window.renderDopesheet;
        if (typeof origRender === 'function') {
            window.renderDopesheet = function () {
                origRender.apply(this, arguments);
                try { AnimAI.drawPhaseBands(); AnimAI.render(); } catch (e) { }
            };
        }
        console.log('[AnimAI] ready — 15 tính năng AI cho animation');
    }
};

window.AnimAI = AnimAI;
window.saveLibrary = function (arr) { try { localStorage.setItem('pixi_anim_lib', JSON.stringify(arr)); } catch (e) { } };

(function boot() {
    let n = 0;
    const tick = () => {
        n++;
        if (typeof Engine !== 'undefined' && Engine.app) { AnimAI.init(); return; }
        if (n < 300) setTimeout(tick, 100);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
})();