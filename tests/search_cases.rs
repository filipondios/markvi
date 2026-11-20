//! Casos de regresión de búsqueda y backlinks.
use markvi_server::{core::pure::WikiIndex, search};
use serde_json::Value;

fn string(args: &[Value], index: usize) -> String {
    args[index].as_str().unwrap().to_string()
}

fn run(name: &str, args: &[Value]) -> Value {
    match name {
        "searchText" => serde_json::to_value(search::search_text(
            &string(args, 0),
            &string(args, 1),
            &string(args, 2),
            args[3].as_u64().unwrap() as usize,
        ))
        .unwrap(),
        "buildHit" => {
            let ranges: Vec<(usize, usize)> = serde_json::from_value(args[3].clone()).unwrap();
            serde_json::to_value(search::build_hit(
                &string(args, 0),
                args[1].as_u64().unwrap() as usize,
                &string(args, 2),
                &ranges,
            ))
            .unwrap()
        }
        "extractLinks" => serde_json::to_value(search::extract_links(&string(args, 0))).unwrap(),
        "markdownTarget" => {
            serde_json::to_value(search::markdown_target(&string(args, 0), &string(args, 1)))
                .unwrap()
        }
        "findBacklinks" => {
            let files: Vec<String> = serde_json::from_value(args[0].clone()).unwrap();
            let index = WikiIndex::new(&files);
            serde_json::to_value(search::find_backlinks(
                &string(args, 1),
                &string(args, 2),
                &string(args, 3),
                &index,
                args[4].as_u64().unwrap() as usize,
            ))
            .unwrap()
        }
        other => panic!("unsupported function: {other}"),
    }
}

#[test]
fn search_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/search.json")).expect("valid fixture");
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(
            case["fn"].as_str().unwrap(),
            case["args"].as_array().unwrap(),
        );
        if actual != case["output"] {
            failures.push(format!(
                "{}:\n  actual={}\n  esperado={}",
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
