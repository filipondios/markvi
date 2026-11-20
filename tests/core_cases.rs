//! Casos de regresión del núcleo: normalización, rutas, wiki y hash.
use markvi_server::core::{hash, pure};
use serde_json::{json, Value};

fn string(args: &[Value], index: usize) -> String {
    args[index].as_str().unwrap().to_string()
}

fn run(name: &str, args: &[Value]) -> Value {
    match name {
        "isCaseSensitive" => json!(pure::is_case_sensitive(&string(args, 0))),
        "normalizePath" => json!(pure::normalize_path(&string(args, 0))),
        "isMarkdownPath" => json!(pure::is_markdown_path(&string(args, 0))),
        "isSafePath" => json!(pure::is_safe_path(&string(args, 0))),
        "normalizeNewPath" => json!(pure::normalize_new_path(&string(args, 0))),
        "splitPath" => {
            let path = string(args, 0);
            let (dir, file) = pure::split_path(&path);
            json!({ "dir": dir, "name": file })
        }
        "viewUrl" => json!(pure::view_url(&string(args, 0))),
        "fileUrl" => json!(pure::file_url(&string(args, 0))),
        "encodeURIComponent" => json!(pure::encode_uri_component(&string(args, 0))),
        "defaultConfig" => serde_json::to_value(pure::default_config()).unwrap(),
        "parseWikiLink" => serde_json::to_value(pure::parse_wiki_link(&string(args, 0))).unwrap(),
        "wikiLinks" => {
            let links = pure::wiki_links(&string(args, 0));
            json!(links)
        }
        "wikiLabel" => {
            let ref_: pure::WikiRef = serde_json::from_value(args[0].clone()).unwrap();
            json!(pure::wiki_label(&ref_))
        }
        "headingSlug" => json!(pure::heading_slug(&string(args, 0))),
        "joinRelative" => {
            json!(pure::join_relative(&string(args, 0), &string(args, 1)))
        }
        "resolve" => {
            let files: Vec<String> = serde_json::from_value(args[0].clone()).unwrap();
            let index = pure::WikiIndex::new(&files);
            json!(index.resolve(&string(args, 1), &string(args, 2)))
        }
        "hash" => json!(format!("{:x}", hash::hash(0, string(args, 0).as_bytes()))),
        other => panic!("unsupported function: {other}"),
    }
}

#[test]
fn core_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/core.json")).expect("valid fixture");
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(
            case["fn"].as_str().unwrap(),
            case["args"].as_array().unwrap(),
        );
        if actual != case["output"] {
            failures.push(format!(
                "{}: actual={} esperado={}",
                case["id"], actual, case["output"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatch(es):\n{}",
        failures.len(),
        failures.join("\n")
    );
    println!("{}/{} casos OK", cases.len() - failures.len(), cases.len());
}
