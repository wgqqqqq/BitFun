//! MiniApp storage-shape helpers.

use crate::miniapp::types::NpmDep;

/// Parse package.json dependencies using the legacy MiniApp storage contract.
pub fn parse_npm_dependencies(package_json: &str) -> Result<Vec<NpmDep>, serde_json::Error> {
    let package: serde_json::Value = serde_json::from_str(package_json)?;
    let Some(deps) = package
        .get("dependencies")
        .and_then(|deps| deps.as_object())
    else {
        return Ok(Vec::new());
    };

    Ok(deps
        .iter()
        .map(|(name, version)| NpmDep {
            name: name.clone(),
            version: version.as_str().unwrap_or("*").to_string(),
        })
        .collect())
}

/// Build package.json using the legacy MiniApp storage contract.
pub fn build_package_json(app_id: &str, deps: &[NpmDep]) -> serde_json::Value {
    let mut dependencies = serde_json::Map::new();
    for dep in deps {
        dependencies.insert(
            dep.name.clone(),
            serde_json::Value::String(dep.version.clone()),
        );
    }

    serde_json::json!({
        "name": format!("miniapp-{}", app_id),
        "private": true,
        "dependencies": dependencies
    })
}
