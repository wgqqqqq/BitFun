use super::util::resolve_path;
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext, ValidationResult};
use crate::util::errors::{BitFunError, BitFunResult};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub struct OfficeDocTool;

impl OfficeDocTool {
    pub fn new() -> Self {
        Self
    }

    fn infer_format(path: &str) -> Option<&'static str> {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())?;
        match ext.as_str() {
            "docx" => Some("docx"),
            "pptx" => Some("pptx"),
            "xlsx" => Some("xlsx"),
            _ => None,
        }
    }

    fn relevant_entries(format: &str, names: &[String]) -> Vec<String> {
        let mut selected = match format {
            "docx" => names
                .iter()
                .filter(|name| {
                    name == &&"word/document.xml".to_string()
                        || name.starts_with("word/header")
                        || name.starts_with("word/footer")
                })
                .cloned()
                .collect::<Vec<_>>(),
            "pptx" => names
                .iter()
                .filter(|name| {
                    name.starts_with("ppt/slides/slide") && name.ends_with(".xml")
                })
                .cloned()
                .collect::<Vec<_>>(),
            "xlsx" => names
                .iter()
                .filter(|name| {
                    name == &&"xl/sharedStrings.xml".to_string()
                        || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
                })
                .cloned()
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        selected.sort();
        selected
    }

    fn decode_xml_entities(text: &str) -> String {
        text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
    }

    fn escape_xml_text(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn build_split_tag_pattern(old_text: &str) -> BitFunResult<String> {
        let chars = old_text.chars().collect::<Vec<_>>();
        if chars.is_empty() {
            return Err(BitFunError::tool(
                "old_text cannot be empty for split-tag pattern".to_string(),
            ));
        }

        let mut pattern = String::new();
        for (index, ch) in chars.iter().enumerate() {
            pattern.push_str(&regex::escape(&ch.to_string()));
            if index + 1 < chars.len() {
                pattern.push_str(r#"(?:<[^>]+>)*"#);
            }
        }
        Ok(pattern)
    }

    fn replace_xml_text_best_effort(
        content: &str,
        old_text: &str,
        new_text: &str,
    ) -> BitFunResult<(String, usize)> {
        let mut updated = content.to_string();
        let mut replaced = 0usize;

        for (from, to) in [
            (old_text.to_string(), new_text.to_string()),
            (Self::escape_xml_text(old_text), Self::escape_xml_text(new_text)),
        ] {
            if from.is_empty() {
                continue;
            }
            let count = updated.matches(&from).count();
            if count > 0 {
                replaced += count;
                updated = updated.replace(&from, &to);
            }
        }

        if replaced > 0 {
            return Ok((updated, replaced));
        }

        let escaped_old = Self::escape_xml_text(old_text);
        let escaped_new = Self::escape_xml_text(new_text);
        let pattern = Self::build_split_tag_pattern(&escaped_old)?;
        let regex = Regex::new(&pattern)
            .map_err(|e| BitFunError::tool(format!("Invalid split-tag regex: {}", e)))?;

        let count = regex.find_iter(&updated).count();
        if count > 0 {
            updated = regex.replace_all(&updated, escaped_new.as_str()).to_string();
            replaced += count;
        }

        Ok((updated, replaced))
    }

    fn xml_to_text(xml: &str) -> String {
        let with_breaks = xml
            .replace("</w:p>", "\n")
            .replace("</a:p>", "\n")
            .replace("</row>", "\n")
            .replace("<w:tab/>", "\t")
            .replace("<w:br/>", "\n")
            .replace("<a:br/>", "\n");

        let mut result = String::with_capacity(with_breaks.len());
        let mut in_tag = false;

        for ch in with_breaks.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => result.push(ch),
                _ => {}
            }
        }

        let decoded = Self::decode_xml_entities(&result);
        decoded
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn read_zip_entries(path: &str) -> BitFunResult<Vec<String>> {
        let file = File::open(path)
            .map_err(|e| BitFunError::tool(format!("Failed to open file {}: {}", path, e)))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|e| BitFunError::tool(format!("Failed to open zip archive: {}", e)))?;

        let mut names = Vec::new();
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|e| BitFunError::tool(format!("Failed to read zip entry: {}", e)))?;
            names.push(entry.name().to_string());
        }
        Ok(names)
    }

    fn extract_text(path: &str, format: &str) -> BitFunResult<String> {
        let file = File::open(path)
            .map_err(|e| BitFunError::tool(format!("Failed to open file {}: {}", path, e)))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|e| BitFunError::tool(format!("Failed to open zip archive: {}", e)))?;

        let names = (0..archive.len())
            .filter_map(|index| archive.by_index(index).ok().map(|entry| entry.name().to_string()))
            .collect::<Vec<_>>();

        let targets = Self::relevant_entries(format, &names);
        if targets.is_empty() {
            return Err(BitFunError::tool(format!(
                "No readable XML parts found for format {}",
                format
            )));
        }

        let mut chunks = Vec::new();
        for name in targets {
            let mut entry = archive
                .by_name(&name)
                .map_err(|e| BitFunError::tool(format!("Failed to open entry {}: {}", name, e)))?;
            let mut xml = String::new();
            entry.read_to_string(&mut xml).map_err(|e| {
                BitFunError::tool(format!("Failed to read XML entry {}: {}", name, e))
            })?;

            let text = Self::xml_to_text(&xml);
            if !text.is_empty() {
                chunks.push(format!("# {}\n{}", name, text));
            }
        }

        Ok(chunks.join("\n\n"))
    }

    fn derive_output_path(input: &str, suffix: &str) -> String {
        let path = Path::new(input);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("document");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let parent = path.parent().unwrap_or(Path::new("."));

        let filename = if ext.is_empty() {
            format!("{}{}", stem, suffix)
        } else {
            format!("{}{}.{}", stem, suffix, ext)
        };
        parent.join(filename).to_string_lossy().to_string()
    }

    fn replace_text(
        path: &str,
        format: &str,
        output_path: Option<&str>,
        old_text: &str,
        new_text: &str,
    ) -> BitFunResult<(String, usize)> {
        let input_file = File::open(path)
            .map_err(|e| BitFunError::tool(format!("Failed to open file {}: {}", path, e)))?;
        let mut input_archive = ZipArchive::new(input_file)
            .map_err(|e| BitFunError::tool(format!("Failed to open zip archive: {}", e)))?;

        let out_path = output_path
            .map(|s| s.to_string())
            .unwrap_or_else(|| Self::derive_output_path(path, "-updated"));

        if let Some(parent) = PathBuf::from(&out_path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BitFunError::tool(format!("Failed to create output directory: {}", e))
            })?;
        }

        let out_file = File::create(&out_path)
            .map_err(|e| BitFunError::tool(format!("Failed to create output file: {}", e)))?;
        let mut writer = ZipWriter::new(out_file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);

        let names = (0..input_archive.len())
            .filter_map(|index| {
                input_archive
                    .by_index(index)
                    .ok()
                    .map(|entry| entry.name().to_string())
            })
            .collect::<Vec<_>>();
        let targets = Self::relevant_entries(format, &names);

        let mut replaced_count = 0usize;

        for index in 0..input_archive.len() {
            let mut entry = input_archive
                .by_index(index)
                .map_err(|e| BitFunError::tool(format!("Failed to read zip entry: {}", e)))?;

            let name = entry.name().to_string();
            if entry.is_dir() {
                writer
                    .add_directory(name, options)
                    .map_err(|e| BitFunError::tool(format!("Failed to write directory: {}", e)))?;
                continue;
            }

            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| BitFunError::tool(format!("Failed to read zip bytes: {}", e)))?;

            if targets.contains(&name) {
                if let Ok(content) = String::from_utf8(bytes.clone()) {
                    let (updated, count) =
                        Self::replace_xml_text_best_effort(&content, old_text, new_text)?;
                    if count > 0 {
                        replaced_count += count;
                        bytes = updated.into_bytes();
                    }
                }
            }

            writer
                .start_file(name, options)
                .map_err(|e| BitFunError::tool(format!("Failed to start zip file: {}", e)))?;
            writer
                .write_all(&bytes)
                .map_err(|e| BitFunError::tool(format!("Failed to write zip file: {}", e)))?;
        }

        writer
            .finish()
            .map_err(|e| BitFunError::tool(format!("Failed to finalize archive: {}", e)))?;

        Ok((out_path, replaced_count))
    }
}

#[async_trait]
impl Tool for OfficeDocTool {
    fn name(&self) -> &str {
        "OfficeDoc"
    }

    async fn description(&self) -> BitFunResult<String> {
        Ok(r#"Work with local Office documents for daily non-code workflows.

Supported formats:
- .docx (Word)
- .pptx (PowerPoint)
- .xlsx (Excel)

Operations:
- extract_text: extract human-readable text from document XML parts
- list_entries: inspect internal package entries
- replace_text: replace text in XML parts and save a new updated file (best-effort across split runs)"#
            .to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["extract_text", "list_entries", "replace_text"]
                },
                "file_path": {
                    "type": "string",
                    "description": "Path to .docx/.pptx/.xlsx file"
                },
                "format": {
                    "type": "string",
                    "enum": ["docx", "pptx", "xlsx"],
                    "description": "Optional explicit format; inferred from extension if omitted"
                },
                "output_path": {
                    "type": "string",
                    "description": "Output path for replace_text (optional)"
                },
                "old_text": {
                    "type": "string",
                    "description": "Text to replace when operation=replace_text"
                },
                "new_text": {
                    "type": "string",
                    "description": "Replacement text when operation=replace_text"
                }
            },
            "required": ["operation", "file_path"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let operation = input.get("operation").and_then(|v| v.as_str());
        let file_path = input.get("file_path").and_then(|v| v.as_str());

        if operation.is_none() || file_path.map(|s| s.trim().is_empty()).unwrap_or(true) {
            return ValidationResult {
                result: false,
                message: Some("operation and file_path are required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult::default()
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> BitFunResult<Vec<ToolResult>> {
        let operation = input
            .get("operation")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BitFunError::tool("operation is required".to_string()))?;

        let file_path = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BitFunError::tool("file_path is required".to_string()))?;

        let resolved_path = resolve_path(file_path);
        let format = input
            .get("format")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| Self::infer_format(&resolved_path).map(|s| s.to_string()))
            .ok_or_else(|| {
                BitFunError::tool(
                    "Unsupported document format; provide docx/pptx/xlsx file".to_string(),
                )
            })?;

        match operation {
            "extract_text" => {
                let text = Self::extract_text(&resolved_path, &format)?;
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "text": text,
                    }),
                    result_for_assistant: Some(text),
                }])
            }
            "list_entries" => {
                let entries = Self::read_zip_entries(&resolved_path)?;
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "entries": entries,
                    }),
                    result_for_assistant: Some(format!(
                        "Office package entries ({}):\n{}",
                        entries.len(),
                        entries.join("\n")
                    )),
                }])
            }
            "replace_text" => {
                let old_text = input
                    .get("old_text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        BitFunError::tool("old_text is required for replace_text".to_string())
                    })?;
                let new_text = input
                    .get("new_text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        BitFunError::tool("new_text is required for replace_text".to_string())
                    })?;

                if old_text.is_empty() {
                    return Err(BitFunError::tool(
                        "old_text cannot be empty for replace_text".to_string(),
                    ));
                }

                let output_path = input.get("output_path").and_then(|v| v.as_str());
                let (out_path, replaced_count) =
                    Self::replace_text(&resolved_path, &format, output_path, old_text, new_text)?;

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "output_path": out_path,
                        "replaced_count": replaced_count,
                    }),
                    result_for_assistant: Some(format!(
                        "Replaced {} occurrence(s), saved to {}",
                        replaced_count, out_path
                    )),
                }])
            }
            _ => Err(BitFunError::tool(format!(
                "Unsupported operation: {}",
                operation
            ))),
        }
    }
}
