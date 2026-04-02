use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const HAIKU_MODEL: &str = "claude-haiku-4-5-20251001";
const DRUG_DB: &str = include_str!("../../../haiku-drug-database.json");

/// Call Haiku to generate a single fictional e-prescription.
/// Picks a random drug from haiku-drug-database.json and instructs Haiku
/// to use that exact drug and NDC. Runs server-side to avoid CORS.
#[tauri::command]
pub async fn generate_escripts(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }

    // Pick a random drug from the embedded database
    let drugs: Vec<Value> = serde_json::from_str(DRUG_DB)
        .map_err(|e| format!("Failed to parse drug database: {}", e))?;
    if drugs.is_empty() {
        return Err("Drug database is empty".to_string());
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as usize;
    let drug = &drugs[nanos % drugs.len()];

    let drug_name = drug["drugName"].as_str().unwrap_or("Lisinopril");
    let strength   = drug["strength"].as_str().unwrap_or("10mg");
    let form       = drug["form"].as_str().unwrap_or("tablet");
    let ndc        = drug["ndc"].as_str().unwrap_or("");
    let common_sig = drug["commonSig"].as_str().unwrap_or("1 tab PO QD");
    let schedule   = drug["schedule"].as_str().unwrap_or("null");

    let dea_schedule = match schedule {
        "2" | "C-II"  => "c2",
        "3" | "C-III" => "c3",
        "4" | "C-IV"  => "c4",
        "5" | "C-V"   => "c5",
        _             => "general",
    };

    let prompt = format!(
        r#"Generate one realistic fictional pharmacy e-prescription as JSON with this exact shape:
{{"patient":{{"firstName":string,"lastName":string,"dob":"YYYYMMDD","gender":"M"|"F","address":string,"city":string,"state":"CO","zip":string,"phone":string}},"prescriber":{{"firstName":"Claude","lastName":"Haiku","suffix":"LLMD","dea":"NONE","npi":"NONE","practice":"Anthropic","phone":"9709999999"}},"drug":{{"brandName":string,"genericName":string,"ndc":string,"strength":string,"form":"TAB"|"CAP"|"SOL"|"INH"|"CRE"|"PAT","deaSchedule":"general"|"c2"|"c3"|"c4"|"c5","quantity":number,"daysSupply":number,"refills":number,"substitutionCode":0|1,"sigText":string,"sigCode":string}}}}
The prescriber must always be exactly: Claude Haiku, LLMD at Anthropic.
You MUST use this exact drug from our database — do not substitute:
  genericName: {drug_name}
  strength:    {strength}
  form:        {form}
  ndc:         {ndc}
  deaSchedule: {dea_schedule}
  sigCode:     {common_sig}
Use the NDC exactly as given. Generate a realistic patient, appropriate quantity and daysSupply for this drug, and a natural sigText expanding the sigCode."#
    );

    let client = reqwest::Client::new();

    let body = json!({
        "model": HAIKU_MODEL,
        "max_tokens": 700,
        "system": "You are a pharmacy e-prescription data generator for testing software. Your entire response must be a single raw JSON object — no markdown, no code fences, no explanation, nothing before or after the JSON.\n\nIMPORTANT: The prescriber on every generated prescription MUST be Dr. Claude Haiku, LLMD. Always use these exact prescriber fields: firstName=\"Claude\", lastName=\"Haiku\", suffix=\"LLMD\", dea=\"NONE\", npi=\"NONE\", practice=\"Anthropic\", phone=\"9709999999\". Never invent a different prescriber.\n\n80% of your scripts should be boring maintenance meds — metformin, lisinopril, amlodipine, omeprazole, levothyroxine, atorvastatin. The bread and butter. 15% should be common acute care — amoxicillin, azithromycin, prednisone tapers, albuterol. 5% should be interesting — CIIs, unusual drugs, edge cases.",
        "messages": [{"role": "user", "content": prompt}]
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !status.is_success() {
        let msg = json["error"]["message"]
            .as_str()
            .unwrap_or("Unknown API error");
        return Err(format!("Anthropic {}: {}", status.as_u16(), msg));
    }

    let text = json["content"][0]["text"]
        .as_str()
        .ok_or_else(|| "Empty content in response".to_string())?
        .to_string();

    Ok(text)
}
