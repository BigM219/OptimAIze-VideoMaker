# OptimAIze-VideoMaker — Harness Design

Thiết kế bộ công cụ (harness) cho LLM tương tác với môi trường dự án video,
theo mẫu kiến trúc của **opencode** (xem [`harness-reference.md`](./harness-reference.md))
nhưng thích ứng với ràng buộc thực tế của VideoMaker.

> Mục tiêu: thay mô hình "LLM trả về cả file mỗi lượt" hiện tại bằng một harness
> tool đúng nghĩa — LLM chủ động đọc/tìm/sửa/chạy lệnh từng bước, có vòng lặp
> agentic, output có cấu trúc + diagnostics phản hồi ngay.

---

## 1. Ràng buộc thực tế (khác opencode ở đâu)

Trước khi thiết kế, phải nắm 4 ràng buộc đã xác minh trong codebase hiện tại:

| Yếu tố | opencode | VideoMaker (hiện tại) | Hệ quả thiết kế |
|---|---|---|---|
| **LLM API** | AI SDK với **native function-calling** (tool schema gửi qua API, model trả `tool_calls`) | `OpenRouterClient.chat()` **chỉ trả text** (string) | Phải dùng **giao thức tool-call bằng JSON block trong text**, tự parse |
| **Hệ tool** | Effect `Schema` + `Tool.define`, layer DI | Chưa có; chỉ có `applyEdits` parse `{files:[…]}` | Xây registry nhẹ, không cần Effect |
| **File ops** | `assertExternalDirectory` + worktree | `store.writeFile/readFile/listFiles` qua `resolveInJail` (đã jail sẵn) | Tái dùng jail; tool chỉ là lớp mỏng bọc store |
| **Thực thi** | tool `bash` tree-sitter parse | `backend.exec(sandboxId, cmd)` (Job Object caged) | Tool `bash` bọc `backend.exec`, không cần parse |

**Quyết định cốt lõi:** vì LLM không có native function-calling, harness dùng
**giao thức JSON-block** (mục 3). Đây là mở rộng tự nhiên của `applyEdits` đang chạy.

Hai impl (TS + Go) phải parity — thiết kế mô tả contract chung, mục 9 ghi chú khác biệt.

---

## 2. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│ director loop (generateConcept / chatEdit)                     │
│                                                                │
│   ┌──────────────┐   text+JSON   ┌────────────────────────┐  │
│   │ OpenRouter    │ ────────────> │ parseToolCalls()        │  │
│   │ .chat()       │ <──────────── │  → ToolCall[]           │  │
│   └──────────────┘   tool results └────────────────────────┘  │
│                                            │                   │
│                                            v                   │
│                              ┌───────────────────────────┐    │
│                              │ ToolRegistry.execute(call) │    │
│                              └───────────────────────────┘    │
│                                            │                   │
│         ┌──────────────┬─────────────┬─────┴────────┐         │
│         v              v             v              v         │
│     read/write     glob/grep      bash          render_scene  │
│     /edit          (search)     (exec)          (domain)      │
│         │                                          │          │
│         v                                          v          │
│   store.writeFile / readFile / listFiles    backend.exec      │
│   (resolveInJail → workdir)                 (Job Object)      │
└─────────────────────────────────────────────────────────────┘
```

- **Director loop**: điều phối; gọi LLM, parse tool-calls, thực thi, nối kết quả
  vào hội thoại, lặp tới khi model phát tín hiệu xong hoặc chạm trần.
- **ToolRegistry**: bảng `id → ToolDef`; validate tham số; gọi `execute`.
- **ToolDef.execute**: trả `{ title, output, metadata }` — `output` là string đưa lại cho LLM.
- **Lớp dưới**: tái dùng `store` (file, jail) + `backend` (exec) sẵn có.

---

## 3. Giao thức tool-call (JSON-block)

Vì LLM chỉ trả text, ta quy ước model phát **một khối JSON có rào** mỗi lượt.
System prompt mô tả giao thức; harness parse khối đó.

### 3.1. Định dạng model phải trả

````
<reasoning ngắn gọn — tùy chọn, harness bỏ qua>

```tool_calls
{
  "calls": [
    { "tool": "read",  "args": { "filePath": "src/scenes/Intro.tsx" } },
    { "tool": "grep",  "args": { "pattern": "interpolate\\(", "include": "*.tsx" } }
  ]
}
```
````

- Khối **bắt buộc** mở bằng ` ```tool_calls ` và đóng bằng ` ``` `.
- `calls`: mảng — cho phép nhiều tool song song trong một lượt (như opencode khuyến khích).
- Khi model muốn **kết thúc** (không cần tool nữa), nó trả một khối đặc biệt:

````
```tool_calls
{ "done": true, "summary": "Đã sửa 3 cảnh, render sạch." }
```
````

### 3.2. Harness trả kết quả về

Sau khi thực thi, harness chèn một message `role:"user"` (hoặc `tool`) chứa kết quả:

````
```tool_results
{
  "results": [
    { "tool": "read", "ok": true,  "output": "<path>…</path>\n1: import…" },
    { "tool": "grep", "ok": true,  "output": "Found 4 matches\n…" }
  ]
}
```
````

- `ok: false` kèm `output` = thông điệp lỗi (model đọc và tự sửa).
- `output` đã được **truncate** theo trần (mục 6); nếu cắt, có dòng `(Output truncated… use offset=…)`.

### 3.3. Vì sao JSON-block, không phải native tools

- `OpenRouterClient.chat()` trả string; nâng lên native tools đòi đổi cả client + mọi provider (z.ai, custom) → rủi ro cao, ngoài phạm vi.
- JSON-block là mở rộng trực tiếp của `applyEdits` đang chạy ổn.
- Nhược điểm: model đôi khi trả JSON sai cú pháp → harness có **lớp khoan dung** (mục 7).

> Khi nào chuyển sang native function-calling: nếu sau này khóa cứng một provider
> hỗ trợ tools API ổn định, có thể thêm `chatWithTools()` và để registry sinh
> JSON Schema gửi thẳng. Thiết kế tool (mục 4-5) **không đổi** — chỉ đổi tầng vận chuyển.

---

## 4. ToolDef — contract chung

Mỗi tool là một object (không cần Effect như opencode):

```ts
interface ToolContext {
  projectId: string;
  store: ProjectStore;          // file ops (đã jail)
  backend: SandboxBackend;      // exec (đã cage)
  sandboxId: string;
  signal?: AbortSignal;
  log: (phase: string, detail: string, extra?: Partial<ProjectStep>) => void;
}

interface ToolResult {
  title: string;                // nhãn ngắn cho transcript
  output: string;               // text đưa lại cho LLM (đã truncate)
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  outputPath?: string;          // nếu output bị ghi ra file vì quá lớn
}

interface ToolDef<A = Record<string, unknown>> {
  id: string;
  description: string;          // text LLM thấy (đưa vào system prompt)
  parameters: JSONSchema;       // để validate + (tương lai) native tools
  validate?(args: unknown): A;  // ép kiểu + thông điệp lỗi rõ ràng
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
```

**Wrapper chung** (giống `tool.ts` của opencode) bọc mọi `execute`:
1. Validate tham số → lỗi sai trả về *"Tool X được gọi với tham số không hợp lệ: … Hãy viết lại input."* (không ném, đưa vào `tool_results` để model tự sửa).
2. Truncate `output` theo trần; set `truncated`/`outputPath`.
3. Bắt exception → biến thành `ok:false` + message (không làm sập loop).
4. Ghi `ProjectStep` vào transcript (kind tương ứng).

---

## 5. Tập tool đầy đủ

Chia 4 nhóm. Cột "opencode" cho biết nguồn gốc; "thích ứng" ghi điểm khác.

### 5.1. Nhóm file

#### `read`
- **opencode:** `read` · **Mục đích:** đọc file/thư mục, đánh số dòng.
- **Input:** `filePath`*(string), `offset`(int 1-based, opt), `limit`(int, opt mặc định 2000).
- **Output:** khối `<path>/<type>/<content>` với mỗi dòng `"{n}: {text}"`; thư mục liệt kê entry + `/`. Trailer báo còn dòng.
- **Thích ứng:** đọc qua `store.readFile`; đường dẫn **bắt buộc bắt đầu `src/` hoặc nằm trong workdir** (jail đã ép). Đánh số dòng để `edit` tham chiếu.
- **Limits:** cắt 50KB; dòng >2000 ký tự cắt; phát hiện binary.

#### `write`
- **opencode:** `write` · **Mục đích:** tạo/đè file.
- **Input:** `filePath`*(string), `content`*(string).
- **Output:** `"Wrote file successfully."` + (nếu có) diagnostics từ `tsc`/lint.
- **Thích ứng:** qua `store.writeFile`. **Bắt buộc đường dẫn `src/`** (như `applyEdits` hiện tại). Sau ghi, chạy **type-check tăng tiến** (mục 8) và chèn lỗi vào output.

#### `edit`
- **opencode:** `edit` (9 chiến lược match) · **Mục đích:** thay chuỗi chính xác, **không rewrite cả file**.
- **Input:** `filePath`*, `oldString`*, `newString`*, `replaceAll`(bool, mặc định false).
- **Output:** `"Edit applied successfully."` + diff + diagnostics.
- **Thích ứng:** port **tối thiểu 3 chiến lược** match (đủ cho phần lớn case, tránh phình code):
  1. `SimpleReplacer` — khớp chính xác.
  2. `LineTrimmedReplacer` — khớp theo dòng đã trim (chịu sai lệch trailing space).
  3. `BlockAnchorReplacer` — khớp dòng đầu+cuối của block ≥3 dòng (chịu thay đổi giữa).
  - Lỗi rõ: *"Không tìm thấy oldString…"*, *"Tìm thấy nhiều khớp — cung cấp thêm ngữ cảnh"*.
- **Lợi ích chính:** giảm token (không gửi lại cả file), ít hỏng file lớn. Đây là tool **quan trọng nhất** cần thêm.

#### `list_files`
- **opencode:** (gộp trong `read` thư mục) · **Mục đích:** liệt kê cây file dự án.
- **Input:** `path`(string, opt mặc định `src`).
- **Output:** danh sách path POSIX, bỏ `node_modules`.
- **Thích ứng:** bọc `collect()` đang có; hữu ích để model định hướng trước khi đọc.

### 5.2. Nhóm tìm kiếm

#### `glob`
- **opencode:** `glob` · **Mục đích:** tìm file theo pattern.
- **Input:** `pattern`*(string), `path`(opt).
- **Output:** danh sách path; `"No files found"`; **limit 100**.
- **Thích ứng:** chạy trên cây file của sandbox (không phải toàn máy). Có thể dùng `backend.exec` với `npx glob` hoặc duyệt `store.listFiles` đệ quy.

#### `grep`
- **opencode:** `grep` · **Mục đích:** tìm nội dung bằng regex.
- **Input:** `pattern`*(string), `path`(opt), `include`(opt vd `"*.tsx"`).
- **Output:** `"Found {n} matches"` + nhóm theo file `{path}:` rồi `  Line {n}: {text}`; **limit 100**.
- **Thích ứng:** ưu tiên `backend.exec("rg --json …")` nếu `rg` có trong sandbox; fallback duyệt file + regex JS.

### 5.3. Nhóm thực thi / điều khiển

#### `bash`
- **opencode:** `bash` (id giữ "bash") · **Mục đích:** chạy lệnh terminal trong sandbox.
- **Input:** `command`*(string), `timeout`(ms, opt), `description`*(string ngắn).
- **Output:** stdout/stderr tail-limited; `"(no output)"` nếu rỗng; chèn `<shell_metadata>` khi timeout.
- **Thích ứng:** bọc thẳng `backend.exec(sandboxId, command, {timeoutS})`. **Không cần tree-sitter** — sandbox đã cage bằng Job Object (RAM/CPU/process cap), nên rủi ro thấp. Timeout mặc định 120s.
- **An ninh:** vì đã cage + jail workdir, không cần permission prompt từng lệnh (khác opencode chạy trên máy thật). Vẫn chặn lệnh rõ ràng phá hoại nếu muốn (tùy chọn).

#### `todowrite`
- **opencode:** `todowrite` · **Mục đích:** model tự quản lý checklist nhiều bước.
- **Input:** `todos`*(array `{content, status, priority}`).
- **Output:** JSON pretty; ghi đè toàn bộ list.
- **Thích ứng:** lưu vào `project.todos` (thêm field), hiển thị ở transcript. Giúp model bám kế hoạch khi sửa nhiều cảnh.

### 5.4. Nhóm domain (đặc thù VideoMaker)

Đây là phần opencode **không có** — tool nghiệp vụ riêng, dùng lại hạ tầng render.

#### `render_scene`
- **Mục đích:** render thử một cảnh để kiểm lỗi runtime ngay (không chờ cả video).
- **Input:** `sceneId`*(string).
- **Output:** `"Scene X rendered OK"` hoặc stderr render (model đọc, sửa).
- **Thích ứng:** dùng cơ chế composition-per-scene đã có; chạy `remotion render <SceneId>` qua `backend.exec`. **Lưu ý:** chính lỗi `interpolate("#fff")` từng gặp sẽ lộ ra ở đây sớm.

#### `update_storyboard`
- **Mục đích:** model điều chỉnh storyboard (thêm/bớt/đổi thứ tự cảnh) có cấu trúc.
- **Input:** `scenes`*(array `{id, title, durationInFrames, narration, visual}`).
- **Output:** xác nhận + storyboard mới.
- **Thích ứng:** ghi `project.storyboard`, rewrite `Root.tsx`, Studio hot-reload.

#### `read_skill_rule`
- **opencode:** gần `skill` · **Mục đích:** nạp một rule cụ thể theo nhu cầu (vd `interpolate`, `transitions`).
- **Input:** `name`*(string — tên rule trong `.optimaize/skills/.../rules/`).
- **Output:** nội dung rule.
- **Thích ứng:** bọc `skillRulesFor`/đọc file rule. Cho model chủ động kéo đúng rule khi gặp lỗi, thay vì luôn nhồi cả SKILL.md.

### 5.5. Tool sentinel

#### `invalid`
- **opencode:** `invalid` · **Mục đích:** placeholder khi model gọi tool không tồn tại / sai args.
- **Output:** echo lỗi để model tự sửa, không sập loop.

---

## 6. Truncation (chống tràn context)

Theo `truncate.ts` của opencode, nhưng tham số gọn:

- **Output mỗi tool** cắt ở **50KB** (đọc) / **30KB** (bash preview). Nếu lớn hơn:
  - Ghi đầy đủ ra `out/.harness/<tool>-<callId>.txt` (trong workdir, jail).
  - `output` giữ phần đầu/đuôi + dòng `(Output truncated to 50KB. Full output: out/.harness/…)`.
- **Dòng** >2000 ký tự cắt với `…`.
- `read` hỗ trợ `offset`/`limit` để model phân trang chủ động.

---

## 7. Lớp khoan dung khi parse (JSON-block dễ sai)

Vì model đôi khi trả JSON lệch, harness có thang đỡ:

1. **Trích khối:** regex lấy nội dung giữa ` ```tool_calls ` … ` ``` `. Nếu không có khối → coi như model trả lời thường (kết thúc nhẹ).
2. **Sửa JSON nhẹ:** bỏ dấu phẩy thừa, bỏ comment `//`, vá nháy đơn → kép (best-effort) trước khi `JSON.parse`.
3. **Parse thất bại:** trả `tool_results` chứa lỗi *"Khối tool_calls không phải JSON hợp lệ: … Hãy trả lại đúng định dạng."* → model thử lại.
4. **Tool lạ / args sai:** route sang `invalid`, không sập.
5. **Trần lượt:** `MAX_TOOL_TURNS` (vd 12) — chống lặp vô hạn; hết trần thì dừng + log.
6. **Chống đứng yên:** nếu 2 lượt liên tiếp không có tool-call và không `done` → kết thúc (giống `noChangeStreak` trong repair loop hiện tại).

---

## 8. Diagnostics tăng tiến (vòng phản hồi)

Điểm mạnh của opencode: lỗi LSP chèn thẳng vào output tool. VideoMaker tương đương:

- Sau `write`/`edit`/`apply_patch`: chạy **type-check nhanh** —
  `backend.exec("npx tsc --noEmit -p tsconfig.json")` (hoặc chỉ file đổi nếu khả thi),
  parse lỗi, chèn `\n\nLSP/tsc errors in this file, please fix:\n…` vào output.
- Giúp model thấy lỗi **ngay sau khi sửa**, không chờ render — rút ngắn vòng lặp.
- Cân nhắc chi phí: type-check cả dự án có thể chậm; có thể debounce hoặc chỉ chạy ở cuối chuỗi edit liên tiếp.

---

## 9. Vòng lặp agentic (thay generateConcept hiện tại)

Pseudo-code (TS; Go parity tương tự):

```ts
async function runAgent(ctx, systemPrompt, userGoal) {
  const messages = [
    { role: "system", content: systemPrompt + "\n\n" + renderToolDocs(registry) },
    { role: "user", content: userGoal },
  ];
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const resp = await client.chat(messages, { maxTokens: 4000 });
    messages.push({ role: "assistant", content: resp });

    const parsed = parseToolBlock(resp);          // mục 7
    if (parsed.done) return parsed.summary;
    if (parsed.calls.length === 0) {              // không tool → chống đứng yên
      if (++idleStreak >= 2) return "(stopped: no progress)";
      messages.push({ role: "user", content: "Tiếp tục, hoặc trả {\"done\":true}." });
      continue;
    }
    idleStreak = 0;

    const results = await Promise.all(            // tool song song
      parsed.calls.map((c) => registry.execute(c, ctx)),
    );
    messages.push({ role: "user", content: renderToolResults(results) }); // mục 3.2
    messages = trimHistory(messages);             // giữ context bounded
  }
  return "(stopped: max turns)";
}
```

- **`renderToolDocs`**: sinh phần mô tả tool (id + description + JSON schema rút gọn) cho system prompt — luôn kèm `skillCore()` (đã có).
- **`trimHistory`**: giữ system + vài lượt gần nhất; mỗi `tool_results` đã mang trạng thái mới nên lượt cũ có thể lược (giống `trimRepair`).
- **Repair lop** trở thành trường hợp riêng: cảnh render lỗi → đẩy stderr vào vòng lặp này như một `tool_results` của `render_scene`.

---

## 10. Tích hợp dần (không phá vỡ hiện tại)

Triển khai theo increment, mỗi bước review được:

1. **Increment A — Registry + giao thức + 4 tool file** (`read`, `write`, `edit`, `list_files`)
   + lớp parse khoan dung. Chưa đổi director; chỉ thêm đường mới chạy song song để test.
2. **Increment B — `bash` + `grep` + `glob`** (bọc `backend.exec` / search).
3. **Increment C — diagnostics tăng tiến** (tsc sau edit) + truncation.
4. **Increment D — tool domain** (`render_scene`, `update_storyboard`, `read_skill_rule`).
5. **Increment E — thay vòng lặp**: `chatEdit` và repair loop chuyển sang `runAgent`.
   Giữ `applyEdits` cũ làm fallback tới khi ổn định.
6. **Increment F — Go parity** cho từng phần đã chốt ở TS.

Mỗi increment: build TS + Go sạch, chạy một generation thật xác nhận không regression,
rồi PR riêng (theo workflow submodule → bump parent).

---

## 11. Bảng đối chiếu nhanh (opencode → VideoMaker)

| opencode tool | VideoMaker | Tái dùng hạ tầng | Ưu tiên |
|---|---|---|---|
| read | `read` | `store.readFile` + đánh số dòng | Cao |
| write | `write` | `store.writeFile` + tsc | Cao |
| edit | `edit` (3 chiến lược) | `store` + matcher mới | **Cao nhất** |
| apply_patch | (bỏ qua giai đoạn đầu) | — | Thấp |
| glob | `glob` | `store.listFiles` / `backend.exec` | Trung |
| grep | `grep` | `backend.exec rg` / regex JS | Trung |
| bash | `bash` | `backend.exec` (đã cage) | Cao |
| task | (bỏ — không có subagent) | — | — |
| todowrite | `todowrite` | `project.todos` | Trung |
| lsp | (thay bằng tsc diagnostics) | `backend.exec tsc` | Trung |
| webfetch/websearch | (bỏ — ngoài phạm vi) | — | — |
| skill | `read_skill_rule` | `skillRulesFor` | Trung |
| question | (dùng chat UI sẵn có) | — | Thấp |
| invalid | `invalid` | — | Cao |
| — | `render_scene` (domain) | composition-per-scene | Cao |
| — | `update_storyboard` (domain) | `rootSource` | Trung |

---

## 12. Rủi ro & lưu ý

- **JSON-block fragile:** model yếu có thể trả sai cú pháp thường xuyên → lớp khoan dung (mục 7) là bắt buộc, và nên log tỉ lệ parse-fail để theo dõi.
- **Chi phí type-check:** tsc cả dự án mỗi edit có thể chậm; cân nhắc debounce.
- **Trần lượt:** đặt `MAX_TOOL_TURNS` đủ để sửa nhiều cảnh nhưng tránh đốt token.
- **Parity TS/Go:** matcher của `edit` phải port chính xác cùng thứ tự chiến lược, nếu không hai impl cho kết quả khác nhau.
- **Tương thích ngược:** giữ `applyEdits` cũ tới khi `runAgent` ổn định, để rollback nhanh.
