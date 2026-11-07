/* =====================================================================
   SPINE-COMPATIBLE RIG (mô phỏng Spine 2D skeleton)
   ---------------------------------------------------------------------
   Mô hình dữ liệu giống Spine 3.x/4.x:
     skeleton: { bones[], slots[], ik[], animations{} }
     bone    : { name, parent, length, x, y, rotation, scaleX, scaleY,
                 shearX, shearY, inheritRotation, inheritScale, transform }
     slot    : { name, bone, attachment, color }
   Bone có ma trận thế giới riêng (worldX, worldY, a,b,c,d) tính như Spine,
   để có thể nội suy / export sang Spine JSON.
   ===================================================================== */

/** Bone của Spine: setup pose + biến đổi local + ma trận world */
class SpineBone {
    constructor(def) {
        this.name = def.name;
        this.parentName = def.parent || null;
        this.parent = null;
        this.length = def.length || 0;
        // setup pose
        this.x = def.x || 0;
        this.y = def.y || 0;
        this.rotation = def.rotation || 0;
        this.scaleX = def.scaleX ?? 1;
        this.scaleY = def.scaleY ?? 1;
        this.shearX = def.shearX ?? 0;
        this.shearY = def.shearY ?? 0;
        this.inheritRotation = def.inheritRotation !== false;
        this.inheritScale = def.inheritScale !== false;
        this.transformMode = def.transformMode || 'normal';
        // runtime pose (bị animation ghi đè)
        this.qx = this.x; this.qy = this.y; this.qrot = this.rotation;
        this.qsx = this.scaleX; this.qsy = this.scaleY;
        // world transform (a,b,c,d,x,y)
        this.wa = 1; this.wb = 0; this.wc = 0; this.wd = 1;
        this.wx = 0; this.wy = 0;
        this.children = [];
        // Pixi Container tao lazy vi PIXI co the chua load xong
        this.container = null;
    }
}

class SpineSkeleton {
    constructor() { this.bones = new Map(); this.ordered = []; this.slots = []; }

    /** build từ mảng bone def (thứ tự cha trước con) */
    ensureContainers() {
        this.ordered.forEach(b => {
            if (!b.container) {
                b.container = new PIXI.Container();
                b.container.label = 'spineBone_' + b.name;
            }
        });
    }

    build(boneDefs) {
        this.bones.clear(); this.ordered = []; this.slots = [];
        boneDefs.forEach(d => this.bones.set(d.name, new SpineBone(d)));
        // tạo container trước khi gắn cha/con
        this.bones.forEach(b => {
            b.container = new PIXI.Container();
            b.container.label = 'spineBone_' + b.name;
        });
        this.bones.forEach(b => {
            if (b.parentName && this.bones.has(b.parentName)) {
                b.parent = this.bones.get(b.parentName);
                b.parent.children.push(b);
                b.parent.container.addChild(b.container);
            }
            this.ordered.push(b);
        });
        this.updateWorldTransform();
        return this;
    }

    /** tính lại ma trận world cho toàn bộ xương (như Skeleton.updateWorldTransform) */
    updateWorldTransform() {
        for (const b of this.ordered) {
            const rot = b.qrot * Math.PI / 180;
            const cos = Math.cos(rot), sin = Math.sin(rot);
            const la = cos * b.qsx;
            const lb = sin * b.qsx;
            const lc = -sin * b.qsy;
            const ld = cos * b.qsy;
            if (b.parent) {
                const p = b.parent;
                if (b.inheritRotation) {
                    b.wa = p.wa * la + p.wb * lc;
                    b.wb = p.wa * lb + p.wb * ld;
                    b.wc = p.wc * la + p.wd * lc;
                    b.wd = p.wc * lb + p.wd * ld;
                } else {
                    b.wa = la; b.wb = lb; b.wc = lc; b.wd = ld;
                }
                b.wx = p.wa * b.qx + p.wb * b.qy + p.wx;
                b.wy = p.wc * b.qx + p.wd * b.qy + p.wy;
            } else {
                b.wa = la; b.wb = lb; b.wc = lc; b.wd = ld;
                b.wx = b.qx; b.wy = b.qy;
            }
            // Container transform được engine gán qua SpineRig.syncBoneContainers()
            // (flat hierarchy — world transform). Không gán ở đây để tránh conflict.
        }
    }

    setToSetupPose() {
        this.bones.forEach(b => {
            b.qx = b.x; b.qy = b.y; b.qrot = b.rotation;
            b.qsx = b.scaleX; b.qsy = b.scaleY;
        });
        this.updateWorldTransform();
    }

    /** lấy ma trận world của 1 bone (dùng để gắn attachment) */
    matrixOf(name) {
        const b = this.bones.get(name);
        if (!b) return null;
        return { a: b.wa, b: b.wb, c: b.wc, d: b.wd, x: b.wx, y: b.wy };
    }

    toSpineJSON() {
        return {
            skeleton: { hash: '', spine: '4.1.00', x: 0, y: 0, width: 1376, height: 768 },
            bones: this.ordered.map(b => ({
                name: b.name,
                parent: b.parentName || undefined,
                length: b.length || undefined,
                x: b.x, y: b.y,
                rotation: b.rotation || undefined,
                scaleX: b.scaleX !== 1 ? b.scaleX : undefined,
                scaleY: b.scaleY !== 1 ? b.scaleY : undefined,
                inheritRotation: b.inheritRotation ? undefined : false,
                inheritScale: b.inheritScale ? undefined : false,
                transform: b.transformMode !== 'normal' ? b.transformMode : undefined
            })),
            slots: this.slots.map(s => ({ name: s.name, bone: s.bone, attachment: s.attachment })),
            ik: [],
            skins: [{ name: 'default', attachments: {} }],
            animations: {}
        };
    }
}

/* =====================================================================
   IK CONSTRAINT (2-bone IK như Spine)
   ===================================================================== */
function solveTwoBoneIK(skel, bone1Name, bone2Name, targetX, targetY, bendPositive) {
    const b1 = skel.bones.get(bone1Name);
    const b2 = skel.bones.get(bone2Name);
    if (!b1 || !b2) return;
    const parentX = b1.parent ? b1.parent.wx : 0;
    const parentY = b1.parent ? b1.parent.wy : 0;
    const dx = targetX - parentX;
    const dy = targetY - parentY;
    const dist = Math.hypot(dx, dy);
    const len1 = b1.length;
    const len2 = b2.length;
    // clamp khoảng cách
    const d = Math.max(Math.abs(len1 - len2) + 0.01, Math.min(len1 + len2, dist));
    // góc của bone1 so với hướng target
    const a1 = Math.acos(Math.max(-1, Math.min(1, (len1 * len1 + d * d - len2 * len2) / (2 * len1 * d))));
    const a2 = Math.acos(Math.max(-1, Math.min(1, (len1 * len1 + len2 * len2 - d * d) / (2 * len1 * len2))));
    const targetAngle = Math.atan2(dy, dx);
    const parentRot = b1.parent ? Math.atan2(b1.parent.wb, b1.parent.wa) : 0;
    const sign = bendPositive ? 1 : -1;
    b1.qrot = ((targetAngle - sign * a1) - parentRot) * 180 / Math.PI;
    b1.qx = dx; b1.qy = dy;
    b2.qrot = (Math.PI - a2) * 180 / Math.PI * sign;
    skel.updateWorldTransform();
}

window.SpineBone = SpineBone;
window.SpineSkeleton = SpineSkeleton;
window.solveTwoBoneIK = solveTwoBoneIK;
