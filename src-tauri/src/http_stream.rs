// === 流式 HTTP 通道（chunk 实时推前端，用于 LLM 逐字输出 / 数字人口型同步） ===
// 普通 http_request 是「等整段响应回来再一次性返回」；流式接口则边收边用事件把每个
// 数据块（base64）推给前端，前端 listen 对应事件即可逐块消费。
// 事件名按 request_id 区分：`http-stream://<request_id>`，payload 形如：
//   { "type": "chunk", "data": "<base64>" }  // 一个数据块
//   { "type": "done" }                        // 正常结束
//   { "type": "error", "message": "..." }     // 出错（同时命令返回 Err）
// 老的 http_request 保留不动，二者并存。

use base64::Engine;
use futures_util::StreamExt;
use tauri::Emitter;

#[tauri::command]
pub async fn http_request_stream(
    app: tauri::AppHandle,
    request_id: String,
    method: Option<String>,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<u16, String> {
    let method = method.unwrap_or_else(|| "POST".to_string());
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("非法 HTTP 方法: {e}"))?;
    let client = reqwest::Client::new();
    let mut req = client.request(m, &url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    // 事件名按 request_id 区分，支持前端同时跑多路流
    let evt = format!("http-stream://{request_id}");
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let _ = app.emit(&evt, serde_json::json!({ "type": "chunk", "data": data }));
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = app.emit(
                    &evt,
                    serde_json::json!({ "type": "error", "message": msg.clone() }),
                );
                return Err(format!("读取流失败: {msg}"));
            }
        }
    }

    // 正常收完，通知前端结束
    let _ = app.emit(&evt, serde_json::json!({ "type": "done" }));
    Ok(status)
}
