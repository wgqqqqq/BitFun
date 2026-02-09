use super::util::resolve_path;
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext, ValidationResult};
use crate::util::errors::{BitFunError, BitFunResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::Path;

pub struct DataFileTool;

impl DataFileTool {
    pub fn new() -> Self {
        Self
    }

    fn infer_format(path: &str) -> Option<&'static str> {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())?;

        match ext.as_str() {
            "json" => Some("json"),
            "yaml" | "yml" => Some("yaml"),
            "toml" => Some("toml"),
            "csv" => Some("csv"),
            "xml" => Some("xml"),
            "ini" | "cfg" | "conf" => Some("ini"),
            _ => None,
        }
    }

    fn parse_structured(format: &str, content: &str) -> BitFunResult<Value> {
        match format {
            "json" => serde_json::from_str(content)
                .map_err(|e| BitFunError::tool(format!("Invalid JSON: {}", e))),
            "yaml" => serde_yaml::from_str::<Value>(content)
                .map_err(|e| BitFunError::tool(format!("Invalid YAML: {}", e))),
            "toml" => {
                let toml_value: toml::Value = toml::from_str(content)
                    .map_err(|e| BitFunError::tool(format!("Invalid TOML: {}", e)))?;
                serde_json::to_value(toml_value)
                    .map_err(|e| BitFunError::tool(format!("TOML conversion failed: {}", e)))
            }
            "csv" => Self::parse_csv(content),
            "ini" => Ok(Self::parse_ini(content)),
            "xml" => Ok(Self::xml_to_simple_json(content)),
            _ => Err(BitFunError::tool(format!("Unsupported format: {}", format))),
        }
    }

    fn serialize_structured(format: &str, data: &Value, pretty: bool) -> BitFunResult<String> {
        match format {
            "json" => {
                if pretty {
                    serde_json::to_string_pretty(data)
                } else {
                    serde_json::to_string(data)
                }
                .map_err(|e| BitFunError::tool(format!("JSON serialization failed: {}", e)))
            }
            "yaml" => serde_yaml::to_string(data)
                .map_err(|e| BitFunError::tool(format!("YAML serialization failed: {}", e))),
            "toml" => {
                let toml_value: toml::Value = serde_json::from_value(data.clone()).map_err(|e| {
                    BitFunError::tool(format!("Data cannot convert to TOML value: {}", e))
                })?;
                toml::to_string_pretty(&toml_value)
                    .map_err(|e| BitFunError::tool(format!("TOML serialization failed: {}", e)))
            }
            "csv" => Self::serialize_csv(data),
            "ini" => Self::serialize_ini(data),
            "xml" => Self::serialize_xml(data),
            _ => Err(BitFunError::tool(format!("Unsupported format: {}", format))),
        }
    }

    fn parse_csv(content: &str) -> BitFunResult<Value> {
        let mut lines = content.lines();
        let headers_line = lines.next().unwrap_or_default();
        if headers_line.trim().is_empty() {
            return Ok(Value::Array(Vec::new()));
        }

        let headers = Self::split_csv_line(headers_line);
        let mut rows = Vec::new();

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let values = Self::split_csv_line(line);
            let mut row = Map::new();
            for (idx, key) in headers.iter().enumerate() {
                let value = values.get(idx).cloned().unwrap_or_default();
                row.insert(key.clone(), Value::String(value));
            }
            rows.push(Value::Object(row));
        }

        Ok(Value::Array(rows))
    }

    fn serialize_csv(data: &Value) -> BitFunResult<String> {
        let rows = data.as_array().ok_or_else(|| {
            BitFunError::tool("CSV serialization requires an array of objects".to_string())
        })?;

        if rows.is_empty() {
            return Ok(String::new());
        }

        let first = rows
            .first()
            .and_then(|v| v.as_object())
            .ok_or_else(|| BitFunError::tool("CSV rows must be objects".to_string()))?;

        let headers: Vec<String> = first.keys().cloned().collect();
        let mut out = String::new();
        out.push_str(&headers.join(","));
        out.push('\n');

        for row in rows {
            let obj = row
                .as_object()
                .ok_or_else(|| BitFunError::tool("CSV rows must be objects".to_string()))?;
            let mut line_values = Vec::new();
            for header in &headers {
                let raw = obj
                    .get(header)
                    .map(|v| {
                        if let Some(s) = v.as_str() {
                            s.to_string()
                        } else {
                            v.to_string()
                        }
                    })
                    .unwrap_or_default();
                let escaped = if raw.contains(',') || raw.contains('"') || raw.contains('\n') {
                    format!("\"{}\"", raw.replace('"', "\"\""))
                } else {
                    raw
                };
                line_values.push(escaped);
            }
            out.push_str(&line_values.join(","));
            out.push('\n');
        }

        Ok(out)
    }

    fn split_csv_line(line: &str) -> Vec<String> {
        let mut result = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let chars: Vec<char> = line.chars().collect();
        let mut index = 0;

        while index < chars.len() {
            let c = chars[index];
            if c == '"' {
                if in_quotes && index + 1 < chars.len() && chars[index + 1] == '"' {
                    current.push('"');
                    index += 2;
                    continue;
                }
                in_quotes = !in_quotes;
                index += 1;
                continue;
            }

            if c == ',' && !in_quotes {
                result.push(current.clone());
                current.clear();
            } else {
                current.push(c);
            }
            index += 1;
        }

        result.push(current);
        result
    }

    fn parse_ini(content: &str) -> Value {
        let mut root = Map::new();
        let mut current_section = "default".to_string();
        root.insert(current_section.clone(), Value::Object(Map::new()));

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }

            if line.starts_with('[') && line.ends_with(']') {
                current_section = line[1..line.len() - 1].trim().to_string();
                root.entry(current_section.clone())
                    .or_insert_with(|| Value::Object(Map::new()));
                continue;
            }

            if let Some(eq_pos) = line.find('=') {
                let key = line[..eq_pos].trim();
                let value = line[eq_pos + 1..].trim();
                if let Some(Value::Object(section_obj)) = root.get_mut(&current_section) {
                    section_obj.insert(key.to_string(), Value::String(value.to_string()));
                }
            }
        }

        Value::Object(root)
    }

    fn serialize_ini(data: &Value) -> BitFunResult<String> {
        let root = data
            .as_object()
            .ok_or_else(|| BitFunError::tool("INI serialization requires object data".to_string()))?;

        let mut out = String::new();

        for (section, section_value) in root {
            let section_obj = section_value.as_object().ok_or_else(|| {
                BitFunError::tool("INI section values must be objects".to_string())
            })?;

            out.push_str(&format!("[{}]\n", section));
            for (key, value) in section_obj {
                let value_str = if let Some(s) = value.as_str() {
                    s.to_string()
                } else {
                    value.to_string()
                };
                out.push_str(&format!("{}={}\n", key, value_str));
            }
            out.push('\n');
        }

        Ok(out)
    }

    fn xml_to_simple_json(content: &str) -> Value {
        // Keep XML support robust without introducing heavy parser dependency here.
        // Return a transport-friendly envelope that can still be edited and written back.
        json!({
            "_xml_raw": content
        })
    }

    fn serialize_xml(data: &Value) -> BitFunResult<String> {
        if let Some(raw) = data.get("_xml_raw").and_then(|v| v.as_str()) {
            return Ok(raw.to_string());
        }
        Err(BitFunError::tool(
            "XML write expects object with '_xml_raw' string field".to_string(),
        ))
    }
}

#[async_trait]
impl Tool for DataFileTool {
    fn name(&self) -> &str {
        "DataFile"
    }

    async fn description(&self) -> BitFunResult<String> {
        Ok(r#"Structured local data file tool for daily-work documents.

Capabilities:
- Read and parse: JSON, YAML, TOML, CSV, INI, XML
- Write structured data back to file
- Patch a top-level field in object-like formats

Use this tool when the task is about manipulating data/config files rather than source code text."#.to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["read", "write", "set"],
                    "description": "Operation: read/parse, write/serialize, or set a top-level key"
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute or workspace-relative path"
                },
                "format": {
                    "type": "string",
                    "enum": ["json", "yaml", "toml", "csv", "xml", "ini"],
                    "description": "Optional explicit format; inferred from extension when omitted"
                },
                "data": {
                    "description": "Structured data for write operation",
                    "type": ["object", "array", "string", "number", "boolean", "null"]
                },
                "key": {
                    "type": "string",
                    "description": "Top-level key for set operation"
                },
                "value": {
                    "description": "New value for set operation",
                    "type": ["object", "array", "string", "number", "boolean", "null"]
                },
                "pretty": {
                    "type": "boolean",
                    "default": true,
                    "description": "Pretty output for json write"
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

        if operation.is_none() || file_path.map(|p| p.trim().is_empty()).unwrap_or(true) {
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
                BitFunError::tool("Cannot infer format from extension; provide format explicitly".to_string())
            })?;

        match operation {
            "read" => {
                let raw = std::fs::read_to_string(&resolved_path).map_err(|e| {
                    BitFunError::tool(format!("Failed to read file {}: {}", resolved_path, e))
                })?;

                let parsed = Self::parse_structured(&format, &raw)?;
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "data": parsed,
                    }),
                    result_for_assistant: Some(format!(
                        "Read structured file: {}\nFormat: {}\nData:\n{}",
                        resolved_path,
                        format,
                        serde_json::to_string_pretty(&parsed).unwrap_or_else(|_| "<serialization failed>".to_string())
                    )),
                }])
            }
            "write" => {
                let data = input
                    .get("data")
                    .ok_or_else(|| BitFunError::tool("data is required for write".to_string()))?;
                let pretty = input
                    .get("pretty")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let serialized = Self::serialize_structured(&format, data, pretty)?;

                if let Some(parent) = Path::new(&resolved_path).parent() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        BitFunError::tool(format!("Failed to create parent directory: {}", e))
                    })?;
                }

                std::fs::write(&resolved_path, serialized.as_bytes()).map_err(|e| {
                    BitFunError::tool(format!("Failed to write file {}: {}", resolved_path, e))
                })?;

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "bytes_written": serialized.len(),
                        "success": true,
                    }),
                    result_for_assistant: Some(format!("Wrote structured file: {}", resolved_path)),
                }])
            }
            "set" => {
                let key = input
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| BitFunError::tool("key is required for set".to_string()))?;
                let value = input
                    .get("value")
                    .ok_or_else(|| BitFunError::tool("value is required for set".to_string()))?;

                let raw = std::fs::read_to_string(&resolved_path).map_err(|e| {
                    BitFunError::tool(format!("Failed to read file {}: {}", resolved_path, e))
                })?;
                let mut parsed = Self::parse_structured(&format, &raw)?;

                let obj = parsed.as_object_mut().ok_or_else(|| {
                    BitFunError::tool(
                        "set currently supports object-like top-level data only".to_string(),
                    )
                })?;
                obj.insert(key.to_string(), value.clone());

                let serialized = Self::serialize_structured(&format, &parsed, true)?;
                std::fs::write(&resolved_path, serialized.as_bytes()).map_err(|e| {
                    BitFunError::tool(format!("Failed to write file {}: {}", resolved_path, e))
                })?;

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "operation": operation,
                        "file_path": resolved_path,
                        "format": format,
                        "key": key,
                        "success": true,
                    }),
                    result_for_assistant: Some(format!(
                        "Updated key '{}' in structured file: {}",
                        key, resolved_path
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
