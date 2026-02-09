use bitfun_core::agentic::tools::framework::ToolUseContext;
use bitfun_core::agentic::tools::implementations::OfficeDocTool;
use bitfun_core::agentic::tools::{Tool, ToolResult};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

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

fn create_test_docx() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("timestamp")
        .as_millis();
    let path = format!("/tmp/office-doc-tool-{}.docx", ts);
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", opts)
        .expect("start content types");
    zip.write_all(b"<Types></Types>")
        .expect("write content types");

    zip.start_file("word/document.xml", opts)
        .expect("start word document");
    zip.write_all(
        br#"<w:document><w:body><w:p><w:r><w:t>Hello OfficeDoc</w:t></w:r></w:p><w:p><w:r><w:t>Second Line</w:t></w:r></w:p></w:body></w:document>"#,
    )
    .expect("write word document");

    zip.finish().expect("finish zip");
    path
}

fn create_test_pptx() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("timestamp")
        .as_millis();
    let path = format!("/tmp/office-ppt-tool-{}.pptx", ts);
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", opts)
        .expect("start content types");
    zip.write_all(b"<Types></Types>")
        .expect("write content types");

    zip.start_file("ppt/slides/slide1.xml", opts)
        .expect("start slide");
    zip.write_all(
        br#"<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>Hello Slide</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>"#,
    )
    .expect("write slide");

    zip.finish().expect("finish zip");
    path
}

fn create_test_xlsx() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("timestamp")
        .as_millis();
    let path = format!("/tmp/office-xlsx-tool-{}.xlsx", ts);
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", opts)
        .expect("start content types");
    zip.write_all(b"<Types></Types>")
        .expect("write content types");

    zip.start_file("xl/sharedStrings.xml", opts)
        .expect("start shared strings");
    zip.write_all(br#"<sst><si><t>Hello Cell</t></si><si><t>Cell B</t></si></sst>"#)
        .expect("write shared strings");

    zip.start_file("xl/worksheets/sheet1.xml", opts)
        .expect("start sheet");
    zip.write_all(br#"<worksheet><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c></row></sheetData></worksheet>"#)
        .expect("write sheet");

    zip.finish().expect("finish zip");
    path
}

#[tokio::test]
async fn office_doc_extract_and_replace_text() {
    let tool = OfficeDocTool::new();
    let context = build_tool_context();
    let path = create_test_docx();

    let extract_input = json!({
        "operation": "extract_text",
        "file_path": path,
    });

    let extract_results = tool
        .call(&extract_input, &context)
        .await
        .expect("extract succeeds");
    assert_eq!(extract_results.len(), 1);

    match &extract_results[0] {
        ToolResult::Result { data, result_for_assistant } => {
            assert_eq!(data["format"], "docx");
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("Hello OfficeDoc"))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected result variant"),
    }

    let replace_input = json!({
        "operation": "replace_text",
        "file_path": path,
        "old_text": "Hello OfficeDoc",
        "new_text": "Hello Replaced"
    });

    let replace_results = tool
        .call(&replace_input, &context)
        .await
        .expect("replace succeeds");

    match &replace_results[0] {
        ToolResult::Result { data, .. } => {
            assert!(data["replaced_count"].as_u64().unwrap_or(0) >= 1);
            let out_path = data["output_path"].as_str().expect("output path exists");
            assert!(fs::metadata(out_path).is_ok());
        }
        _ => panic!("unexpected result variant"),
    }
}

#[tokio::test]
async fn office_doc_extract_pptx_text() {
    let tool = OfficeDocTool::new();
    let context = build_tool_context();
    let path = create_test_pptx();

    let input = json!({
        "operation": "extract_text",
        "file_path": path,
    });

    let results = tool.call(&input, &context).await.expect("extract succeeds");
    match &results[0] {
        ToolResult::Result {
            data,
            result_for_assistant,
        } => {
            assert_eq!(data["format"], "pptx");
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("Hello Slide"))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected result variant"),
    }
}

#[tokio::test]
async fn office_doc_extract_xlsx_text() {
    let tool = OfficeDocTool::new();
    let context = build_tool_context();
    let path = create_test_xlsx();

    let input = json!({
        "operation": "extract_text",
        "file_path": path,
    });

    let results = tool.call(&input, &context).await.expect("extract succeeds");
    match &results[0] {
        ToolResult::Result {
            data,
            result_for_assistant,
        } => {
            assert_eq!(data["format"], "xlsx");
            assert!(
                result_for_assistant
                    .as_ref()
                    .map(|s| s.contains("Hello Cell"))
                    .unwrap_or(false)
            );
        }
        _ => panic!("unexpected result variant"),
    }
}
