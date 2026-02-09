use bitfun_core::agentic::tools::framework::ToolUseContext;
use bitfun_core::agentic::tools::implementations::WebFetchTool;
use bitfun_core::agentic::tools::{Tool, ToolResult};
use serde_json::json;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn build_tool_context() -> ToolUseContext {
    ToolUseContext {
        tool_call_id: None,
        message_id: None,
        agent_type: None,
        session_id: None,
        dialog_turn_id: None,
        safe_mode: None,
        abort_controller: None,
        read_file_timestamps: HashMap::new(),
        options: None,
        response_state: None,
        image_context_provider: None,
        subagent_parent_info: None,
        cancellation_token: None,
    }
}

#[tokio::test]
async fn web_fetch_reads_local_http_json() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local test server");
    let addr = listener.local_addr().expect("local addr");

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept connection");
        let mut buf = [0u8; 1024];
        let _ = socket.read(&mut buf).await.expect("read request");

        let body = r#"{"status":"ok","source":"local-test"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );

        socket
            .write_all(response.as_bytes())
            .await
            .expect("write response");
    });

    let url = format!("http://{}/data", addr);
    let tool = WebFetchTool::new();
    let context = build_tool_context();

    let input = json!({
        "url": url,
        "format": "json"
    });

    let results = tool.call(&input, &context).await.expect("tool call succeeds");
    assert_eq!(results.len(), 1);

    match &results[0] {
        ToolResult::Result { data, result_for_assistant } => {
            assert_eq!(data["format"], "json");
            assert_eq!(data["url"], input["url"]);
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("\"status\":\"ok\""))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected tool result variant"),
    }

    server.await.expect("server task completes");
}

#[tokio::test]
async fn web_fetch_public_example_domain() {
    let tool = WebFetchTool::new();
    let context = build_tool_context();
    let input = json!({
        "url": "https://example.com",
        "format": "text"
    });

    let results = tool.call(&input, &context).await.expect("public fetch succeeds");
    assert_eq!(results.len(), 1);

    match &results[0] {
        ToolResult::Result {
            data,
            result_for_assistant,
        } => {
            assert_eq!(data["url"], "https://example.com");
            assert_eq!(data["format"], "text");
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("Example Domain"))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected tool result variant"),
    }
}

#[tokio::test]
async fn web_fetch_public_jsonplaceholder_json() {
    let tool = WebFetchTool::new();
    let context = build_tool_context();
    let input = json!({
        "url": "https://jsonplaceholder.typicode.com/todos/1",
        "format": "json"
    });

    let results = tool.call(&input, &context).await.expect("public json fetch succeeds");
    assert_eq!(results.len(), 1);

    match &results[0] {
        ToolResult::Result {
            data,
            result_for_assistant,
        } => {
            assert_eq!(data["url"], "https://jsonplaceholder.typicode.com/todos/1");
            assert_eq!(data["format"], "json");
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("\"id\": 1") || s.contains("\"id\":1"))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected tool result variant"),
    }
}
