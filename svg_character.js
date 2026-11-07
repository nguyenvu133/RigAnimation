/* =========================================================================
   DEBUG MARKER — dòng này phải xuất hiện trong view-source. Bump khi sửa. */
window.__SVG_BUILD = 'v3-2026-11-04';
/* =====================================================================
   svg_character.js — load SVG nhân vật (do AI sinh) thành rig Spine-style
   ---------------------------------------------------------------------
   Cách hoạt động:
   1. Đọc file SVG (knight_ai.svg). Mỗi <g id="..."> là 1 bộ phận (part).
   2. Với mỗi group: đo bbox (getBBox) → tạo bone tại điểm neo (pivot),
      gắn group đó vào container bone (như attachment).
   3. Skeleton = SpineSkeleton có sẵn (spine_rig.js), bone theo cây giải phẫu.
   4. Animation: dùng AnimationSystem có sẵn (clip idle/walk/attack...).
   ===================================================================== */

const SVG_BONES = [
    { name: 'root', parent: null, x: 0, y: 0, len: 20 },
    { name: 'hips', parent: 'root', x: 0, y: 0, len: 30 },
    { name: 'leg_upper_L', parent: 'hips', x: -18, y: 4, len: 55 },
    { name: 'leg_lower_L', parent: 'leg_upper_L', x: 0, y: 55, len: 50 },
    { name: 'foot_L', parent: 'leg_lower_L', x: 0, y: 50, len: 26 },
    { name: 'leg_upper_R', parent: 'hips', x: 18, y: 4, len: 55 },
    { name: 'leg_lower_R', parent: 'leg_upper_R', x: 0, y: 55, len: 50 },
    { name: 'foot_R', parent: 'leg_lower_R', x: 0, y: 50, len: 26 },
    { name: 'torso', parent: 'hips', x: 0, y: -28, len: 70 },
    { name: 'neck', parent: 'torso', x: 0, y: -64, len: 12 },
    { name: 'head', parent: 'neck', x: 0, y: 0, len: 60 },
    { name: 'arm_upper_L', parent: 'torso', x: -30, y: -52, len: 42 },
    { name: 'arm_lower_L', parent: 'arm_upper_L', x: 0, y: 42, len: 38 },
    { name: 'hand_L', parent: 'arm_lower_L', x: 0, y: 38, len: 24 },
    { name: 'arm_upper_R', parent: 'torso', x: 30, y: -52, len: 42 },
    { name: 'arm_lower_R', parent: 'arm_upper_R', x: 0, y: 42, len: 38 },
    { name: 'hand_R', parent: 'arm_lower_R', x: 0, y: 38, len: 24 },
    { name: 'weapon', parent: 'hand_R', x: 8, y: 0, len: 60, dir: -15 }
];

/** map tên bone → id group trong SVG (AI có thể đặt hơi khác) */
const SVG_PART_ALIASES = {
    root: null, hips: ['hips', 'pelvis', 'hip'],
    torso: ['torso', 'chest', 'body'],
    neck: null, head: ['head', 'helmet', 'face'],
    arm_upper_L: ['arm_upper_L', 'arm_upper_left', 'upper_arm_L', 'arm_L', 'shoulder_L'],
    arm_lower_L: ['arm_lower_L', 'forearm_L', 'lower_arm_L'],
    hand_L: ['hand_L', 'fist_L', 'palm_L'],
    arm_upper_R: ['arm_upper_R', 'arm_upper_right', 'upper_arm_R', 'arm_R', 'shoulder_R'],
    arm_lower_R: ['arm_lower_R', 'forearm_R', 'lower_arm_R'],
    hand_R: ['hand_R', 'fist_R', 'palm_R'],
    leg_upper_L: ['leg_upper_L', 'thigh_L', 'upper_leg_L', 'leg_L'],
    leg_lower_L: ['leg_lower_L', 'shin_L', 'calf_L', 'lower_leg_L'],
    foot_L: ['foot_L', 'feet_L', 'boot_L'],
    leg_upper_R: ['leg_upper_R', 'thigh_R', 'upper_leg_R', 'leg_R'],
    leg_lower_R: ['leg_lower_R', 'shin_R', 'calf_R', 'lower_leg_R'],
    foot_R: ['foot_R', 'feet_R', 'boot_R'],
    weapon: ['sword', 'weapon', 'blade', 'weapon_blade']
};

const SvgCharacter = {
    loaded: false, groups: {}, boneById: {}, skel: null,

    /** parse text SVG → DOM, trả về map id group → element (đã strip transform gốc) */
    parse(svgText) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) throw new Error('SVG không hợp lệ');
        // xoá script/style để an toàn
        svg.querySelectorAll('script, style, foreignObject').forEach(n => n.remove());
        const groups = {};
        svg.querySelectorAll('g[id]').forEach(g => { groups[g.id] = g; });
        // group không có id nhưng nằm trong group có id → đã nằm trong groups của cha
        return { svg, groups };
    },

    /** đo bbox của 1 group (tính cả transform) — dùng getBBox của chính group trong svg tạm */
    measure(tempSvg, groupEl) {
        // groupEl đang nằm trong tempSvg (đã gắn vào DOM tạm) → getBBox chính xác
        try {
            const b = groupEl.getBBox();
            return { x: b.x, y: b.y, w: b.width, h: b.height };
        } catch (e) { return null; }
    },

    /**
     * Load SVG → build skeleton + gắn part.
     * @param {string} svgText nội dung file .svg
     * @param {EditorScene} scene scene PixiJS hiện tại
     */
    async load(svgText, scene) {
        const { svg, groups } = this.parse(svgText);
        // svg tạm ẩn trong DOM để getBBox hoạt động
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:600px;';
        holder.appendChild(document.importNode(svg, true));
        document.body.appendChild(holder);
        const liveSvg = holder.querySelector('svg');
        const liveGroups = {};
        liveSvg.querySelectorAll('g[id]').forEach(g => { liveGroups[g.id] = g; });

        // 1) đo bbox của từng id group → map boneName → box (theo hệ toạ độ SVG)
        const boxes = {};
        for (const [boneName, ids] of Object.entries(SVG_PART_ALIASES)) {
            if (!ids) continue;
            for (const id of ids) {
                const el = liveGroups[id];
                if (!el) continue;
                const bb = this.measure(liveSvg, el);
                if (bb && bb.w > 1 && bb.h > 1) { boxes[boneName] = { id, ...bb }; break; }
            }
        }
        holder.remove();
        if (!boxes.torso || !boxes.head) throw new Error('SVG thiếu part torso/head (cần <g id="torso"> và <g id="head">)');

        // 2) tính vị trí bone từ bbox: root = giữa 2 hông, mốc dưới = chân
        const legTopY = Math.min((boxes.leg_upper_L || boxes.leg_upper_R).y, (boxes.leg_upper_R || boxes.leg_upper_L).y);
        const footBottom = Math.max((boxes.foot_L || boxes.foot_R).y + (boxes.foot_L || boxes.foot_R).h,
            (boxes.foot_R || boxes.foot_L).y + (boxes.foot_R || boxes.foot_L).h);
        const headTop = boxes.head.y;
        const torso = boxes.torso;
        const hipsX = (torso.x + torso.w / 2);
        const hipsY = torso.y + torso.h * 0.92;   // gốc hông gần đáy torso
        // scale toàn cục: app dùng toạ độ riêng, ta đặt root tại (0,0) = hips
        const rootX = hipsX, rootY = hipsY;

        // 3) build bone defs — toạ độ local giống SpineRig.TEMPLATE nhưng đo từ SVG
        const hipL = boxes.leg_upper_L, hipR = boxes.leg_upper_R;
        const defs = [
            { name: 'root', parent: null, x: 0, y: 0, rotation: 0, length: 20 },
            { name: 'hips', parent: 'root', x: 0, y: 0, rotation: 0, length: 30 }
        ];
        const addLeg = (side, box) => {
            const s = side.toUpperCase();
            const dx = (box.x + box.w * 0.5) - rootX;
            const dy = (box.y + box.h * 0.18) - rootY;
            defs.push({ name: 'leg_upper_' + s, parent: 'hips', x: dx, y: dy, rotation: 0, length: box.h * 0.72 });
            defs.push({ name: 'leg_lower_' + s, parent: 'leg_upper_' + s, x: 0, y: box.h * 0.72, rotation: 0, length: box.h * 0.7 });
            const f = boxes['foot_' + s];
            if (f) defs.push({ name: 'foot_' + s, parent: 'leg_lower_' + s, x: 0, y: box.h * 0.7, rotation: 0, length: f.h * 0.5 });
        };
        if (hipL) addLeg('L', hipL);
        if (hipR) addLeg('R', hipR);
        // torso: gốc ở hông, hướng lên (Pixi: y âm)
        defs.push({ name: 'torso', parent: 'hips', x: 0, y: -(hipsY - torso.y - torso.h * 0.1), rotation: 0, length: torso.h * 0.8 });
        if (boxes.neck) {
            const n = boxes.neck;
            defs.push({ name: 'neck', parent: 'torso', x: 0, y: -Math.abs(hipsY - (n.y + n.h / 2)), rotation: 0, length: 12 });
        } else {
            defs.push({ name: 'neck', parent: 'torso', x: 0, y: -torso.h * 0.92, rotation: 0, length: 12 });
        }
        const head = boxes.head;
        defs.push({ name: 'head', parent: 'neck', x: 0, y: 0, rotation: 0, length: head.h * 0.8 });
        // tay: vai = top-outer của torso
        const shY = torso.y + torso.h * 0.18;
        ['L', 'R'].forEach(s => {
            const up = boxes['arm_upper_' + s], lo = boxes['arm_lower_' + s], hd = boxes['hand_' + s];
            if (!up) return;
            const sx = (s === 'L' ? torso.x + torso.w * 0.12 : torso.x + torso.w * 0.88);
            defs.push({ name: 'arm_upper_' + s, parent: 'torso', x: sx - rootX, y: shY - rootY, rotation: s === 'L' ? 12 : -12, length: up.h * 0.8 });
            if (lo) defs.push({ name: 'arm_lower_' + s, parent: 'arm_upper_' + s, x: 0, y: up.h * 0.8, rotation: 0, length: lo.h * 0.75 });
            if (hd) defs.push({ name: 'hand_' + s, parent: 'arm_lower_' + s, x: 0, y: (lo ? lo.h * 0.75 : up.h * 0.8), rotation: 0, length: 24 });
        });
        if (boxes.weapon) {
            defs.push({ name: 'weapon', parent: 'hand_R', x: 8, y: 0, rotation: -15, length: 60 });
        }

        // 4) build skeleton
        const skel = new SpineSkeleton();
        skel.build(defs);

        // 5) render từng group SVG thành texture Pixi (SVG → canvas qua Image)
        // rà soát kích thước vẽ
        const vb = (svg.viewBox && svg.viewBox.baseVal) || { width: 400, height: 600 };
        const scale = 1.4;   // phóng nhẹ cho rõ
        this.groups = {};
        this.boneById = {};
        let count = 0;
        for (const [boneName, box] of Object.entries(boxes)) {
            const gEl = liveGroups[box.id];
            if (!gEl) continue;
            const tex = await this.svgGroupToTexture(holder2 => holder2, gEl, box, scale, liveSvg, vb);
            if (!tex) continue;
            const bone = skel.bones.get(boneName);
            if (!bone) continue;
            const sp = new PIXI.Sprite(tex);
            // pivot = điểm neo của part (nơi bone bắt đầu)
            const pivot = this.pivotFor(boneName, box);
            sp.anchor.set(0, 0);
            sp.pivot.set(tex.width * pivot[0], tex.height * pivot[1]);
            sp.rotation = -Math.PI / 2;  // SVG đứng dọc, bone hướng xuống
            sp.position.set(0, 0);
            bone.container.addChild(sp);
            bone.sprite = sp;
            bone.partKey = box.id;
            this.groups[boneName] = { id: box.id, box, sprite: sp };
            this.boneById[box.id] = boneName;
            count++;
        }
        this.skel = skel;
        this.loaded = count > 0;

        // 6) thay rig trong scene
        this.installIntoScene(scene, skel);
        return { skel, count, boxes };
    },

    /** render 1 group SVG → PIXI.Texture bằng canvas (dùng XMLSerializer + Image) */
    async svgGroupToTexture(_, gEl, box, scale, liveSvg, vb) {
        // serialize riêng group này thành 1 svg mới với cùng viewBox để giữ toạ độ
        const clone = gEl.cloneNode(true);
        const w = Math.max(2, Math.ceil(box.w * scale)), h = Math.max(2, Math.ceil(box.h * scale));
        const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${w}" height="${h}">${new XMLSerializer().serializeToString(clone)}</svg>`;
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0);
        return PIXI.Texture.from(cv);
    },

    /** điểm neo theo loại part (tỉ lệ trong bbox) */
    pivotFor(boneName, box) {
        if (/^head/.test(boneName)) return [0.5, 0.92];          // cổ ở đáy đầu
        if (/^torso|body/.test(boneName)) return [0.5, 0.02];     // đỉnh thân
        if (/^hips|pelvis/.test(boneName)) return [0.5, 0.10];
        if (/^leg_upper/.test(boneName)) return [0.5, 0.12];
        if (/^leg_lower/.test(boneName)) return [0.5, 0.08];
        if (/^foot/.test(boneName)) return [0.42, 0.15];
        if (/^arm_upper/.test(boneName)) return [boneName.endsWith('L') ? 0.18 : 0.82, 0.15];
        if (/^arm_lower/.test(boneName)) return [0.5, 0.10];
        if (/^hand/.test(boneName)) return [0.5, 0.15];
        if (/^weapon|sword/.test(boneName)) return [0.12, 0.5];   // chuôi
        return [0.5, 0.5];
    },

    /** thay rigLayer trong scene bằng skeleton SVG */
    installIntoScene(scene, skel) {
        if (scene.rigLayer) scene.rigLayer.destroy({ children: true });
        scene.rigLayer = new PIXI.Container();
        scene.rigLayer.label = 'spine_layer_svg';
        scene.world.addChild(scene.rigLayer);
        scene.rigLayer.addChild(skel.bones.get('root').container);
        scene.spine = skel;
        scene.spineDebug = new PIXI.Graphics();
        scene.rigLayer.addChild(scene.spineDebug);
        scene.spineDebug.visible = (document.getElementById('chk-skeleton-toggle') || {}).checked ?? true;
        skel.setupPose ? skel.setupPose() : skel.setToSetupPose();
        skel.updateWorldTransform();
        scene.rigReady = true;
        scene.drawSpineDebug();
        scene.layoutSpine();
        setText('bone-count', skel.ordered.length);
        renderSpineBonesList();
    }
};

/* publish trực tiếp lên window của TRANG này (không dùng defaultView/unsafeWindow) */
window.SvgCharacter = SvgCharacter;
window.__SVG_CHAR_READY = Date.now();
(function flag() {
    var d = document.createElement('div');
    d.id = 'svgchar-ready-flag';
    d.style.display = 'none';
    d.textContent = (typeof window.SvgCharacter) + ' ' + new Date().toISOString();
    (document.documentElement || document.body).appendChild(d);
})();
console.log('[svg_character] ready', typeof window.SvgCharacter);
