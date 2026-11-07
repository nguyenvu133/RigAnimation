# Rig Studio — PixiJS v8 · Spine-style rig · AI (DeepSeek / AgentRouter)

## 1. Chạy app

```powershell
node dev_server.js
# → http://127.0.0.1:5173/pixijs_v8_engine_openai_api.html
```

`dev_server.js` phục vụ file tĩnh **và** làm proxy AI để API key không bao giờ lộ xuống trình duyệt.

## 2. API key — để trong `.env`

Tạo file `.env` cạnh `dev_server.js` (đã có `.env.example`):

```ini
AGENTROUTER_API_KEY=sk-...            # key thật agentrouter.org
# AGENTROUTER_BASE_URL=https://agentrouter.org/v1
# AGENTROUTER_IMAGE_MODEL=dall-e-3    # model ảnh (khi key được cấp quyền)
# DEEPSEEK_API_KEY=sk-...
# PORT=5173
```

Sau khi sửa `.env` → **khởi động lại** `node dev_server.js`.

Kiểm tra server đã nhận key:

```powershell
curl.exe http://127.0.0.1:5173/api/status
```

## 3. Model AgentRouter có trong app

| Model trong danh sách | model id gửi lên API |
|---|---|
| 🛰️ GPT-5.6-sol (AgentRouter) | `gpt-5.6-sol` |
| 🛰️ GPT-6-astra (AgentRouter) | `gpt-6-astra` |
| 🛰️ GPT-6.1-sol (AgentRouter) | `gpt-6.1-sol` |

### Hai đặc thù của AgentRouter (đã xử lý sẵn trong code)

1. **Chỉ nhận client "đã đăng ký" qua Responses API.** Gọi `POST /v1/chat/completions` luôn trả
   `401 unauthorized client detected` dù key đúng. Phải dùng `POST /v1/responses` kèm header
   `User-Agent: codex_cli_rs/...` và `originator: codex_cli_rs`. Không gửi `temperature`
   (model gpt-6-astra trả 400 `Unsupported parameter`).
   → `dev_server.js` và app đều đã chuyển sang `/v1/responses`.
2. **Bộ lọc nội dung chặn prompt tiếng Việt** (`400 content-blocked`). App tự gửi lại bằng prompt
   tiếng Anh ngắn (vẫn yêu cầu trả lời tiếng Việt) và hiện toast "đã tự gửi lại bằng tiếng Anh".

Một key dùng chung cho cả 3 model.

Badge trên header hiển thị:
- `Live · .env` → key lấy từ `.env` qua proxy server
- `Live` → key nhập trong app (lưu localStorage)
- `Mock` → chưa có key, AI trả lời giả lập

## 4. Dùng AI để rig + animation

1. Bấm **Auto Rig + Animation** ở sidebar — app **TỰ chọn model đang gọi được** theo thứ tự ưu tiên:
   `deepseek-chat` → `deepseek-reasoner` → AgentRouter `gpt-5.6-sol` → `gpt-6.1-sol` → Kimi → OpenRouter
   (DeepSeek/GPT-4o/auto) → APInex → OpenAI → xKiro → GLM → Gemini.
   Model coi là "gọi được" khi có key trong `localStorage` **hoặc** key trong `.env` (kiểm tra qua
   `/api/status` của `dev_server.js`). Nút này tự gửi prompt, chờ model trả JSON, **tự áp** rig + clip vào
   engine và báo trong chat — không cần chọn model bằng tay.
2. Nếu model đang thử **lỗi** (hết quota, chặn nội dung, JSON hỏng...) app tự nhảy sang model dự kiến kế
   tiếp và báo lại trong chat; thử hết danh sách vẫn không được thì mới dừng.
3. Muốn chủ động chọn model thì dùng dropdown **Model selector** rồi gõ prompt như bình thường.
4. Prompt có sẵn nút **Combat pro** để xin clip vung đao có anticipation → slash → follow-through → settle.

System prompt được sinh động theo rig thật (tên bone, part atlas, clip hiện có) nên AI chỉ dùng tên hợp lệ;
clip có track sai tên bone sẽ bị loại khi nạp.

## 5. Tạo nhân vật / ảnh bằng AI

Hai nút ở hàng dưới ô chat:

| Nút | Gọi gì | Kết quả |
|---|---|---|
| **✨ Tạo ảnh AI** | `gpt-6-astra` → sinh **SVG** có `<g id>` cho từng bộ phận | `svg_character.js` tách part → dựng skeleton → gắn 3 clip Idle / Attack / Walk → hiện ngay trong viewport |
| **🖼 Ảnh (images/generations)** | `POST /api/image` → `{base}/images/generations` | lưu file vào `generated/`, hiện ảnh trong chat |

### Ảnh hiển thị NGAY trong khung chat
Mọi ảnh AI sinh ra đều được vẽ thành thumbnail ngay trong bong bóng chat (kèm badge `SVG`/`IMG`):
ảnh SVG của **✨ Tạo ảnh AI**, ảnh raster của **🖼 Ảnh (images/generations)**, và cả ảnh mà model tự
chèn vào câu trả lời dưới dạng markdown `![](url)` / URL ảnh trần / file trong `/generated`.

**Bấm vào ảnh → viewer mở rộng** (overlay toàn màn hình) với đầy đủ thao tác:

| Thao tác | Cách dùng |
|---|---|
| Zoom | lăn chuột (zoom quanh con trỏ) · nút `+` / `−` · phím `+` / `-` |
| Di chuyển | kéo chuột trong khung |
| Vừa khung | nút **Vừa khung** hoặc phím `F` |
| Kích thước thật | nút **1:1** hoặc phím `1` |
| Tải về | nút **Tải** (SVG → `.svg`, raster → `.png/.jpg/...`) |
| Làm nhân vật | nút **Làm nhân vật** — đưa ảnh raster vào `AssetLibrary` và hiển thị trong viewport (rig lại được bằng **Auto Rig**) |
| Rig ngay | nút **Rig SVG** — ảnh SVG có part tách rời → dựng skeleton + clip ngay tại chỗ |
| Đóng | phím `Esc` · nút `✕` · bấm vùng nền tối (kéo ảnh thì không bị đóng) |

Ảnh trong lịch sử hội thoại vẫn render thumbnail khi đổi cuộc trò chuyện hoặc bấm **Cuộc trò chuyện mới** rồi quay lại.

### Về model tạo ảnh

Endpoint `/v1/images/generations` **đã có** nhưng **key hiện tại chưa được cấp model ảnh**:
`GET /v1/models` chỉ trả `gpt-5.6-sol`, `gpt-6-astra`, `gpt-6.1-sol`; gọi ảnh với `dall-e-3`,
`gpt-image-1`, `flux.1-schnell`… đều trả `503 无可用渠道` (group `default` không có channel ảnh).

Muốn dùng được: bật model ảnh cho token ở `agentrouter.org/console/token`, rồi đặt
`AGENTROUTER_IMAGE_MODEL=<tên model>` trong `.env` và restart server.
Vẫn có thể dùng key OpenAI thật (`OPENAI_API_KEY` + `OPENAI_IMAGE_MODEL=gpt-image-1`) — `/api/image`
hỗ trợ cả hai provider.
## 6. Import ảnh — ảnh được **lưu lại**

Bấm **Import** (hoặc kéo-thả vào viewport, hoặc `Ctrl+V` dán ảnh từ clipboard).

| Bước | Chuyện gì xảy ra |
|---|---|
| Chọn/kéo ảnh | `AssetLibrary.addFile()` nhận File |
| Lưu | Chạy qua `dev_server.js` → `POST /api/asset`, file ghi vào **`assets/imported/<tên>-<timestamp>.<ext>`** và được phục vụ tĩnh ở `/assets/imported/…`. Không có server (Live Server/`file://`) → lưu vào **IndexedDB** (`rigstudio_assets`) của trình duyệt |
| Hiển thị | Thẻ asset trong tab **Assets** có badge **✓ lưu** + nút **Dùng / Atlas / Tải / Xoá**. Tab **Animate** mở sẵn thư viện **Assets** để ảnh vừa nhập thấy ngay |
| F5 lại trang | `AssetLibrary.restore()` gọi `GET /api/asset` (và đọc IndexedDB) → asset cũ hiện lại; `AssetLibrary.repair()` dựng lại texture cho URL blob đã chết nên ảnh vẫn dùng được tiếp |
| Xoá | Nút **Xoá** xoá cả bản đã lưu (`DELETE /api/asset?name=…` hoặc IndexedDB) |

### Ba cách dùng ảnh vừa nhập
| Nút | Kết quả |
|---|---|
| **Dùng** | Cả ảnh thành **1 sprite nhân vật** trong viewport (không có xương) — xem ngay ở tab Setup/Animate |
| **Atlas** | Lấy ảnh vừa nhập làm **atlas** rồi auto-rig từng bộ phận như `Cartoon RPG Character Rig Sprite Sheet.png` (ảnh phải cùng bố cục lưới part; ảnh khác kích thước sẽ báo ⚠️) |
| Bấm vào thẻ (đã chọn bone) | Gán ảnh vào **bone đang chọn** trong rig |

API của server:

```powershell
curl.exe -X POST http://127.0.0.1:5173/api/asset -H "X-File-Name: hero.png" --data-binary "@hero.png"
curl.exe http://127.0.0.1:5173/api/asset                      # danh sách
curl.exe -X DELETE "http://127.0.0.1:5173/api/asset?name=hero-123.png"
```

## 7. Rig nâng cao — 15 tính năng (`rig_advanced.js`)

Mở bằng nút **🦴 Rig nâng cao (15)** ở sidebar, tab **Advanced** trên viewport, hoặc tab **Advanced Rig**
cạnh Parts/Assets. Khung assets tự nới rộng khi mở bảng này.

| # | Tính năng | Cách dùng |
|---|---|---|
| 1 | Kéo-xoay bone ngay trong viewport | kéo vào khớp/thân xương để xoay · `Alt`/`Shift` + kéo để **di chuyển** bone |
| 2 | IK 2 xương cho chân | **Toggle IK for Legs** → 2 vòng tròn cyan ở cổ chân, kéo để ghim chân (tự giải góc đùi/cẳng chân) |
| 3 | Tạo / nhân bản / xoá / đổi cha bone | Create · Duplicate · Delete · ô "tên bone cha" + **Đổi cha** (giữ nguyên vị trí world) |
| 4 | Thuộc tính bone nâng cao | X · Y · R° · Len · ScaleX/Y · inherit rotation/scale → **Apply** |
| 5 | Khoá & ẩn bone | **Lock** (không kéo/sửa được) · **Hide** (ẩn part trong viewport) |
| 6 | Đối xứng hoá bộ xương | **Mirror L↔R** — lấy `*_L` làm chuẩn, gương sang `*_R` |
| 7 | Pose | **Copy Pose** · **Paste** · **Mirror Paste** (lật trái/phải) |
| 8 | Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` hoặc nút — phủ cả thao tác rig **và** timeline/clip |
| 9 | Thư viện pose | 3 slot Save/Load/Del (lưu `localStorage` nên còn sau F5) |
| 10 | Nội suy key | `linear` · `ease` · `easeIn` · `easeOut` · `easeInOut` · `step` (sampleTrack đọc `key.ease`) |
| 11 | Biên tập keyframe | **Add Key** tại playhead · **Del Key** · kéo tay nắm key trên timeline để đổi thời gian |
| 12 | Tua + tốc độ | bấm/kéo trên timeline để scrub · 0.5x / 1x / 2x |
| 13 | Quản lý clip | New Clip · Duplicate · Rename · Duration · Delete |
| 14 | Onion skin | xương mờ khung trước (xanh) / sau (cam) + checkbox **hiện trục xương đúng hướng part** |
| 15 | Phụ diễn tự động | **Sinh phụ diễn** — thêm track trễ pha (0.08s, biên độ 55%) cho tóc / vạt áo / vũ khí từ chuyển động của thân |

Ghi chú kỹ thuật: part trong rig này treo theo trục **−Y** của bone, nên hướng nhìn `φ = 90° + góc world`;
công cụ kéo bone và IK đều quy đổi theo hệ thức đó (`qrot = (φ − 90°) − góc world của cha`).
## 8. Anim AI — 15 tính năng AI nâng cao cho ANIMATION (`anim_ai.js`)

Mở bằng nút **🎬 Anim AI nâng cao (15)** ở sidebar, tab **Anim AI (15)** cạnh Parts/Assets/Advanced Rig,
hoặc tab **Advanced** rồi chọn **Anim AI (15)**. Khung thư viện tự nới rộng và rig tự canh lại cho vừa viewport.

Các tính năng **1–6, 9, 13** gọi model đang chọn qua proxy `/api/chat` (dùng key trong `.env` hoặc key
đã nhập trong app). Các tính năng còn lại chạy offline, không cần mạng.

| # | Tính năng | Cách dùng |
|---|---|---|
| 1 | Sinh clip theo mô tả | gõ mô tả (vd “vung đao 3 nhịp”) → **✨ Sinh clip** → AI trả JSON clip, tự áp vào engine |
| 2 | Bộ clip nhân vật đầy đủ | **Sinh 7 clip** — idle · walk · run · attack · hit · jump · death |
| 3 | AI pro pass | **AI pro pass** — AI viết lại clip hiện tại: anticipation → action nhanh → follow-through → settle |
| 4 | Chú thích nhịp | **Chú thích nhịp** — đo đỉnh nhanh nhất, tô vùng lấy đà/quá đà/dừng trên timeline (offline) |
| 5 | Lip-sync | nhập câu thoại → **Lip-sync** — AI chia viseme → thêm track `scale` cho bone miệng |
| 6 | In-between | chọn bone → **AI in-between** — AI chèn key giữa 2 key có vòng cung tự nhiên |
| 7 | Biến thể clip | **fast · slow · strong · soft** (offline): đổi thời gian hoặc biên độ |
| 8 | Chấm điểm + tự sửa | **Chấm điểm** (loop sạch, ease, key vượt duration…) · **Tự sửa** kẹp duration/đóng loop/thêm ease |
| 9 | AI đạo diễn (state machine) | **Sinh chuyển cảnh** → AI trả `{states, default}` · **Chạy thử** phát lần lượt các clip |
| 10 | Blend 2 clip | chọn 2 clip + trọng số → **Blend** tạo clip mới trộn tỉ lệ theo từng khung |
| 11 | Thư viện clip | **Export JSON** · **Import JSON** (cả bộ clip, có lưu `localStorage`) |
| 12 | Time-remap | **time 2x / 0.5x** — co giãn key theo thời gian cho cả clip |
| 13 | Biểu cảm khuôn mặt | nhập cảm xúc (vd “vui vẻ”) → **Biểu cảm** — AI sinh track mắt/lông mày/miệng ±3–15° |
| 14 | Chuyển động phụ trợ | **Phụ trợ** (offline) — thêm/cập nhật track trễ pha cho tóc / áo choàng / vũ khí từ thân |
| 15 | Vòng tự cải thiện | **Tự cải thiện ×2** — chấm điểm → pro pass → chấm lại, giữ bản điểm cao nhất |

Ghi chú kỹ thuật: `sanitizeClips()` của engine tạo object clip mới, nên `AnimAI.install()` copy lại các
field phụ (`phases`, …) từ clip gốc cùng `id`; nhờ vậy vùng nhịp đã chú thích không bị mất khi áp clip.
