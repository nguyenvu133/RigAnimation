/* =====================================================================
   dev_server.js — server tĩnh + proxy AI (DeepSeek / AgentRouter) cho Rig Studio
   ---------------------------------------------------------------------
   API key nằm trong file .env, KHÔNG gửi xuống trình duyệt.

   Tạo file .env cùng thư mục:
       AGENTROUTER_API_KEY=sk-...
       DEEPSEEK_API_KEY=sk-...            (tuỳ chọn)
       # AGENTROUTER_BASE_URL=https://agentrouter.org/v1
       # PORT=5173

   Chạy:
       node dev_server.js
   Mở:
       http://127.0.0.1:5173/pixijs_v8_engine_openai_api.html
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/* ---- đọc .env (không cần thư viện ngoài) ---- */
function loadDotEnv(file) {
    const out = {};
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
    txt.split(/\r?\n/).forEach(line => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return;
        const i = s.indexOf('=');
        if (i < 0) return;
        const k = s.slice(0, i).trim();
        let v = s.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[k] = v;
    });
    return out;
}
const ENV_FILE = path.join(ROOT, '.env');
const FILE_ENV = loadDotEnv(ENV_FILE);
const env = k => (process.env[k] || FILE_ENV[k] || '').trim();

const PORT = Number(env('PORT') || 5173);
const USER_AGENT = env('HTTP_USER_AGENT') ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* Mỗi provider: key + base URL + kiểu API.
   - 'chat'      : POST {base}/chat/completions (OpenAI-compatible)
   - 'responses' : POST {base}/responses (OpenAI Responses API, dạng Codex dùng)
   AgentRouter chỉ cho phép các client "được đăng ký" — gọi /chat/completions trả
   401 "unauthorized client detected" dù key đúng; /responses + header client thì OK. */
const PROVIDERS = {
    openrouter: {
        name: 'OpenRouter',
        key: env('OPENROUTER_API_KEY'),
        base: env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1',
        api: 'chat',
        defaultModel: 'openai/gpt-4o',
        models: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4o-2024-11-20',
                 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001',
                 'mistralai/mistral-large', 'meta-llama/llama-3.3-70b-instruct',
                 'deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct',
                 'openrouter/auto'],
        headers: {
            'User-Agent': env('OPENROUTER_UA') || 'RigStudio/1.0',
            'X-Title': 'Rig Studio'
        }
    },
    agentrouter: {
        name: 'AgentRouter',
        key: env('AGENTROUTER_API_KEY'),
        base: env('AGENTROUTER_BASE_URL') || 'https://agentrouter.org/v1',
        api: 'responses',
        defaultModel: 'gpt-5.6-sol',
        models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol'],
        headers: {
            // bắt buộc: AgentRouter nhận diện client qua 2 header này
            'User-Agent': env('AGENTROUTER_UA') || 'codex_cli_rs/0.40.0',
            originator: 'codex_cli_rs'
        }
    },
    deepseek: {
        name: 'DeepSeek',
        key: env('DEEPSEEK_API_KEY'),
        base: env('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1',
        api: 'chat',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner']
    },
    /* Kimi (Moonshot) — OpenAI-compatible, platform.kimi.ai */
    kimi: {
        name: 'Kimi (Moonshot)',
        key: env('KIMI_API_KEY'),
        base: env('KIMI_BASE_URL') || 'https://platform.kimi.ai/v1',
        api: 'chat',
        defaultModel: 'kimi-k2-0905',
        models: ['kimi-k2-0905', 'kimi-latest'],
        headers: {
            'User-Agent': env('KIMI_UA') || 'RigStudio/1.0'
        }
    },
    openai: {
        name: 'OpenAI',
        key: env('OPENAI_API_KEY'),
        base: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
        api: 'chat',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o']
    },
    /* xKiro — OpenAI-compatible, model id dạng "vendor/model" (docs.xkiro.com) */
    xkiro: {
        name: 'xKiro',
        key: env('XKIRO_API_KEY'),
        base: env('XKIRO_BASE_URL') || 'https://api.xkiro.com/v1',
        api: 'chat',
        // CHỈ 2 model này chạy được với key Free (đo thực tế):
        // premium/gpt-5.6-sol, claude, gemini → 403 paid; qwen *:free → 503 hết slot
        defaultModel: 'mistralai/ministral-3b',
        models: ['mistralai/ministral-3b', 'cohere/command-r-08-2024']
    },
    /* APInex — OpenAI-compatible (api.apinex.bond/v1) */
    apinex: {
        name: 'APInex',
        key: env('APINEX_API_KEY'),
        base: env('APINEX_BASE_URL') || 'https://api.apinex.bond/v1',
        api: 'chat',
        defaultModel: 'free/qwen-3.8-max',
        models: ['free/qwen-3.8-max', 'free/deepseek-v4.1-flash', 'free/gemini-3.8-flash', 'free/gpt-6-luna', 'free/kimi-k3', 'free/glm-5.3']
    }
};

/* ---------------- Model TẠO ẢNH (images/generations) ----------------
   Mỗi mục: key riêng (hoặc dùng chung key chat) + base + danh sách model.
   .env:
     AGENTROUTER_IMAGE_MODEL=dall-e-3        (model ảnh được cấp cho key)
     AGENTROUTER_IMAGE_URL=https://agentrouter.org/v1/images/generations
     OPENAI_IMAGE_MODEL=gpt-image-1          (tuỳ chọn, dùng OPENAI_API_KEY)
   Key chưa được cấp model ảnh → server trả lỗi rõ ràng cho UI.                */
const IMAGE_PROVIDERS = {
    agentrouter: {
        name: 'AgentRouter',
        key: env('AGENTROUTER_IMAGE_KEY') || env('AGENTROUTER_API_KEY'),
        url: env('AGENTROUTER_IMAGE_URL') || 'https://agentrouter.org/v1/images/generations',
        models: [env('AGENTROUTER_IMAGE_MODEL') || 'dall-e-3', 'gpt-image-1', 'dall-e-3', 'flux.1-schnell'],
        headers: {
            'User-Agent': env('AGENTROUTER_UA') || 'codex_cli_rs/0.40.0',
            originator: 'codex_cli_rs'
        }
    },
    openai: {
        name: 'OpenAI',
        key: env('OPENAI_API_KEY'),
        url: env('OPENAI_IMAGE_URL') || 'https://api.openai.com/v1/images/generations',
        models: [env('OPENAI_IMAGE_MODEL') || 'gpt-image-1', 'gpt-image-1', 'dall-e-3', 'dall-e-2'],
        headers: { 'User-Agent': USER_AGENT }
    },
    /* xKiro: POST https://api.xkiro.com/v1/images/generations (docs.xkiro.com/models/image) */
    xkiro: {
        name: 'xKiro',
        key: env('XKIRO_API_KEY'),
        url: env('XKIRO_IMAGE_URL') || 'https://api.xkiro.com/v1/images/generations',
        models: [env('XKIRO_IMAGE_MODEL') || 'openai/gpt-image-2.5', 'openai/gpt-image-2.5', 'sensenova/sensenova-u1.5-lite'],
        headers: { 'User-Agent': USER_AGENT }
    },
    /* APInex: POST https://api.apinex.bond/v1/images/generations (trả b64_json) */
    apinex: {
        name: 'APInex',
        key: env('APINEX_API_KEY'),
        url: env('APINEX_IMAGE_URL') || 'https://api.apinex.bond/v1/images/generations',
        models: [env('APINEX_IMAGE_MODEL') || 'grok-imagine-2', 'grok-imagine-2', 'gemini-3.1-flash-image'],
        headers: { 'User-Agent': USER_AGENT }
    }
};

/* messages kiểu chat → input kiểu Responses API */
function toResponsesInput(messages) {
    return (messages || []).map(m => {
        const type = m.role === 'assistant' ? 'output_text' : 'input_text';
        return { role: m.role === 'system' ? 'developer' : m.role, content: [{ type, text: String(m.content || '') }] };
    });
}

/* các model AgentRouter đốt rất nhiều token cho reasoning (đo được: 4k token reasoning →
   status=incomplete + output rỗng). App gửi reasoningEffort để hạ mức suy luận. */
const REASONING_MODELS = /gpt-6|gpt-5\.6/i;

/* kết quả Responses API → chuỗi text */
function responsesText(j) {
    if (!j) return '';
    if (typeof j.output_text === 'string' && j.output_text) return j.output_text;
    const parts = [];
    (j.output || []).forEach(o => (o.content || []).forEach(c => {
        if (typeof c.text === 'string') parts.push(c.text);
    }));
    return parts.join('');
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.woff2': 'font/woff2'
};

/* đuôi file hợp lệ cho asset import (ảnh + video) */
const ASSET_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
                    '.mp4', '.webm', '.ogv', '.mov', '.mkv'];

function send(res, code, body, type) {
    res.writeHead(code, {
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(body);
}

async function handleChat(req, res) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', async () => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, '{"error":"bad json"}', MIME['.json']); }

        const pname = (body.provider || 'agentrouter').toLowerCase();
        const p = PROVIDERS[pname];
        if (!p) return send(res, 400, JSON.stringify({ error: 'Provider không hỗ trợ qua proxy: ' + pname }), MIME['.json']);
        if (!p.key) return send(res, 503, JSON.stringify({ error: `Server chưa có ${pname.toUpperCase()}_API_KEY trong .env` }), MIME['.json']);

        /* LUÔN dùng model client gửi lên; chỉ fallback defaultModel khi không có.
           Trước đây model ngoài danh sách cứng bị ghi đè → chọn model khác mà server
           vẫn gửi defaultModel (APInex trả về grok-imagine-2). */
        const model = (body.model && String(body.model).trim()) || p.defaultModel;
        const payload = {
            model,
            messages: body.messages || [],
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
            max_tokens: 4096
        };
        // ghi ra console để thấy server thực gửi gì (không log key)
        console.log(`[chat] ${pname} ${p.api} model=${model} msgs=${payload.messages.length} key=${p.key.slice(0, 7)}…(${p.key.length})`);
        try {
            const url = p.base.replace(/\/+$/, '') + (p.api === 'responses' ? '/responses' : '/chat/completions');
            const headers = {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: 'Bearer ' + p.key,
                ...(p.headers || { 'User-Agent': USER_AGENT })
            };
            let reqBody;
            if (p.api === 'responses') {
                // KHÔNG gửi temperature: gpt-6-astra/gpt-5.6-sol trả 400 "Unsupported parameter"
                reqBody = {
                    model,
                    input: toResponsesInput(payload.messages),
                    max_output_tokens: Math.min(32000, Math.max(512, Number(body.maxOutputTokens) || 4096))
                };
                if (body.reasoningEffort && REASONING_MODELS.test(model)) {
                    reqBody.reasoning = { effort: body.reasoningEffort };
                }
            } else {
                reqBody = payload;
            }
            // timeout 120s: gateway AgentRouter đôi khi treo → trả 504 thay vì để client quay vô hạn
            const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(120000) });
            const text = await r.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { /* giữ text thô */ }

            if (!r.ok) {
                const rawMsg = (data && (data.error && (data.error.message || data.error) || data.message)) || text.slice(0, 300);
                let human = rawMsg;
                if (r.status === 401) human = `AgentRouter từ chối (401): ${rawMsg}. Kiểm tra key ở agentrouter.org/console/token và header client (AGENTROUTER_UA).`;
                if (r.status === 404) human = `Model/key không có quyền (404): ${rawMsg}`;
                return send(res, r.status, JSON.stringify({ error: human }), MIME['.json']);
            }

            // trả về đúng format mà app đang đọc: choices[].message.content
            const outText = p.api === 'responses' ? responsesText(data) : '';
            if (p.api === 'responses') {
                return send(res, 200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: outText || '(trống)' } }], _raw: outText ? undefined : data }), MIME['.json']);
            }
            send(res, r.status, text, MIME['.json']);
        } catch (e) {
            console.log('[chat] fail:', e.message);
            if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                return send(res, 504, JSON.stringify({ error: `${p.name} không phản hồi sau 120s (gateway timeout) — thử lại hoặc đổi model.` }), MIME['.json']);
            }
            send(res, 502, JSON.stringify({ error: `Không gọi được ${p.name}: ` + e.message }), MIME['.json']);
        }
    });
}

/* =============================================================
   POST /api/image  { provider, model, prompt, size, quality, n }
   → gọi /images/generations, lưu file vào ./generated/ và trả về URL
   ============================================================= */
const GEN_DIR = path.join(ROOT, 'generated');
try { fs.mkdirSync(GEN_DIR, { recursive: true }); } catch (e) { /* ignore */ }

async function handleImage(req, res) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, '{"error":"bad json"}', MIME['.json']); }
        const pname = (body.provider || 'agentrouter').toLowerCase();
        const p = IMAGE_PROVIDERS[pname];
        if (!p) return send(res, 400, JSON.stringify({ error: 'Provider ảnh không hỗ trợ: ' + pname }), MIME['.json']);
        if (!p.key) return send(res, 503, JSON.stringify({ error: `Chưa có key cho model ảnh (${pname}) trong .env` }), MIME['.json']);
        if (!body.prompt) return send(res, 400, JSON.stringify({ error: 'Thiếu prompt' }), MIME['.json']);

        const model = body.model || p.models[0];
        const payload = { model, prompt: String(body.prompt).slice(0, 4000), n: Math.min(4, Math.max(1, Number(body.n) || 1)) };
        if (body.size) payload.size = body.size;
        if (body.quality) payload.quality = body.quality;
        if (/gpt-image/i.test(model)) payload.output_format = 'png';
        // APInex trả b64_json → xin thẳng base64 để không phụ thuộc URL tạm
        if (pname === 'apinex') payload.response_format = 'b64_json';

        console.log(`[image] ${pname} model=${model} key=${p.key.slice(0, 7)}…(${p.key.length})`);
        try {
            const r = await fetch(p.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + p.key, ...(p.headers || {}) },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(180000)   // tạo ảnh có thể lâu → 3 phút
            });
            const text = await r.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { /* raw */ }

            if (!r.ok) {
                const rawMsg = String((data && (data.error && (data.error.message || data.error) || data.message)) || text.slice(0, 400));
                let hint = '';
                if (r.status === 402 || /insufficient balance|top up/i.test(rawMsg)) {
                    hint = ` — tài khoản ${p.name} hết số dư / chưa nạp tiền (cần trả phí cho model ảnh).`;
                } else if (r.status === 403 || /paid model|free plan/i.test(rawMsg)) {
                    hint = ` — ${p.name} chỉ cho dùng model MIỄN PHÍ: model "${model}" là bản trả phí.`;
                } else if (r.status === 404 || /not found|no channel|无可用/i.test(rawMsg)) {
                    hint = ` — ${p.name} không có model ảnh "${model}". Model ảnh đang liệt kê: ${(p.models || []).join(', ')}.`;
                }
                return send(res, r.status, JSON.stringify({ error: rawMsg + hint, triedModel: model, available: p.models }), MIME['.json']);
            }

            const items = data.data || data.images || [];
            if (!items.length) return send(res, 502, JSON.stringify({ error: 'Response không có ảnh', raw: JSON.stringify(data).slice(0, 400) }), MIME['.json']);

            const urls = [];
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const fname = `img_${Date.now()}_${i}.png`;
                const fpath = path.join(GEN_DIR, fname);
                if (it.b64_json) {
                    fs.writeFileSync(fpath, Buffer.from(it.b64_json, 'base64'));
                } else if (it.url) {
                    const ir = await fetch(it.url);
                    if (!ir.ok) continue;
                    fs.writeFileSync(fpath, Buffer.from(await ir.arrayBuffer()));
                } else continue;
                urls.push('/generated/' + fname);
            }
            if (!urls.length) return send(res, 502, JSON.stringify({ error: 'Không tải/lưu được ảnh' }), MIME['.json']);
            console.log('[image] saved', urls.join(', '));
            send(res, 200, JSON.stringify({ ok: true, model, urls, revisedPrompt: items[0] && items[0].revised_prompt }), MIME['.json']);
        } catch (e) {
            console.log('[image] fail:', e.message);
            if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                return send(res, 504, JSON.stringify({ error: `${p.name} không trả ảnh sau 180s (timeout) — thử lại.` }), MIME['.json']);
            }
            send(res, 502, JSON.stringify({ error: `Không gọi được ${p.name} images: ` + e.message }), MIME['.json']);
        }
    });
}

/* =============================================================
   /api/asset — lưu / liệt kê / xoá ảnh & video người dùng nhập
   File lưu ở ./assets/imported/ và được phục vụ như file tĩnh
   (/assets/imported/<tên>) nên ảnh vẫn còn sau khi reload trang.
   ============================================================= */
const IMPORT_DIR = path.join(ROOT, 'assets', 'imported');
try { fs.mkdirSync(IMPORT_DIR, { recursive: true }); } catch (e) { /* ignore */ }

/** tên file an toàn: bỏ đường dẫn, ký tự lạ, thêm mốc thời gian */
function safeAssetName(raw) {
    const base = path.basename(String(raw || 'asset'));
    const ext = (path.extname(base) || '').toLowerCase();
    let stem = base.slice(0, base.length - ext.length).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'asset';
    const keep = ASSET_EXTS.includes(ext) ? ext : '.png';
    return `${stem}-${Date.now()}${keep}`;
}

function listImported() {
    try {
        return fs.readdirSync(IMPORT_DIR)
            .filter(n => ASSET_EXTS.includes(path.extname(n).toLowerCase()))
            .map(n => {
                const st = fs.statSync(path.join(IMPORT_DIR, n));
                return { name: n, url: '/assets/imported/' + encodeURIComponent(n), size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch (e) { return []; }
}

function handleAssetSave(req, res) {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
        total += c.length;
        if (total > 64 * 1e6) { req.destroy(); return; }   // trần 64MB / file
        chunks.push(c);
    });
    req.on('end', () => {
        if (!chunks.length) return send(res, 400, JSON.stringify({ error: 'Body rỗng' }), MIME['.json']);
        const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'asset.png'));
        const ext = (path.extname(rawName) || '').toLowerCase();
        if (!ASSET_EXTS.includes(ext)) {
            return send(res, 415, JSON.stringify({ error: 'Định dạng không hỗ trợ: ' + ext, allowed: ASSET_EXTS }), MIME['.json']);
        }
        const name = safeAssetName(rawName);
        const buf = Buffer.concat(chunks);
        try {
            fs.writeFileSync(path.join(IMPORT_DIR, name), buf);
        } catch (e) {
            return send(res, 500, JSON.stringify({ error: 'Không ghi được file: ' + e.message }), MIME['.json']);
        }
        const url = '/assets/imported/' + encodeURIComponent(name);
        console.log(`[asset] saved ${name} (${(buf.length / 1024).toFixed(1)} KB) → ${url}`);
        send(res, 200, JSON.stringify({ ok: true, name, url, size: buf.length }), MIME['.json']);
    });
    req.on('error', () => send(res, 400, JSON.stringify({ error: 'Upload lỗi' }), MIME['.json']));
}

function handleAssetList(res) {
    send(res, 200, JSON.stringify({ ok: true, items: listImported() }), MIME['.json']);
}

function handleAssetDelete(url, res) {
    const name = path.basename(decodeURIComponent(url.searchParams.get('name') || ''));
    if (!name || name === '.' || name === '..' || !ASSET_EXTS.includes(path.extname(name).toLowerCase())) {
        return send(res, 400, JSON.stringify({ error: 'Tên file không hợp lệ' }), MIME['.json']);
    }
    const abs = path.join(IMPORT_DIR, name);
    if (!abs.startsWith(IMPORT_DIR)) return send(res, 403, 'Forbidden');
    try {
        fs.unlinkSync(abs);
        console.log('[asset] deleted ' + name);
        send(res, 200, JSON.stringify({ ok: true, name }), MIME['.json']);
    } catch (e) {
        send(res, 404, JSON.stringify({ error: 'Không xoá được: ' + e.message }), MIME['.json']);
    }
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/chat') {
        if (req.method !== 'POST') return send(res, 405, 'POST only');
        return handleChat(req, res);
    }
    if (url.pathname === '/api/image') {
        if (req.method !== 'POST') return send(res, 405, 'POST only');
        return handleImage(req, res);
    }
    /* ASSET IMPORT: lưu ảnh/video người dùng nhập vào ./assets/imported/
       POST /api/asset   (body nhị phân, tên file ở header X-File-Name)
       GET  /api/asset   → danh sách asset đã lưu (để nạp lại sau khi reload)
       DELETE /api/asset?name=...  → xoá 1 asset đã lưu */
    if (url.pathname === '/api/asset') {
        if (req.method === 'POST') return handleAssetSave(req, res);
        if (req.method === 'GET') return handleAssetList(res);
        if (req.method === 'DELETE') return handleAssetDelete(url, res);
        return send(res, 405, 'GET/POST/DELETE only');
    }
    if (url.pathname === '/api/status') {
        const info = {};
        Object.entries(PROVIDERS).forEach(([k, p]) => { info[k] = { ready: !!p.key, models: p.models, base: p.base }; });
        info.image = {};
        Object.entries(IMAGE_PROVIDERS).forEach(([k, p]) => { info.image[k] = { ready: !!p.key, models: p.models, url: p.url }; });
        info.envFile = fs.existsSync(ENV_FILE);
        return send(res, 200, JSON.stringify(info), MIME['.json']);
    }
    let file = decodeURIComponent(url.pathname);
    if (file === '/' || file === '') file = '/pixijs_v8_engine_openai_api.html';
    // không cho tải .env
    if (path.basename(file) === '.env') return send(res, 403, 'Forbidden');
    const abs = path.join(ROOT, file);
    if (!abs.startsWith(ROOT)) return send(res, 403, 'Forbidden');
    fs.readFile(abs, (err, data) => {
        if (err) return send(res, 404, 'Not found: ' + file);
        send(res, 200, data, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    });
});

server.listen(PORT, () => {
    console.log(`Rig Studio  →  http://127.0.0.1:${PORT}/pixijs_v8_engine_openai_api.html`);
    Object.entries(PROVIDERS).forEach(([k, p]) => {
        console.log(`  ${k.padEnd(12)} ${p.key ? 'ON  ' : 'OFF '} ${p.base}  [${p.models.join(', ')}]`);
    });
    if (!fs.existsSync(ENV_FILE)) console.log('  ⚠ chưa có .env — hãy tạo .env với AGENTROUTER_API_KEY=sk-...');
});
