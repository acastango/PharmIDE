use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RxStatus {
    Received,
    InEntry,
    EntryComplete,
    InVerify,
    Verified,
    InFill,
    FillComplete,
    ReadyPickup,
    Sold,
    Returned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub rx_id: String,
    pub patient_name: String,
    pub drug_name: String,
    pub status: RxStatus,
    pub assigned_to: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub items: Vec<QueueItem>,
    pub current_user: String,
}

#[tauri::command]
pub fn get_queue_state() -> Result<QueueState, String> {
    Ok(QueueState {
        items: vec![],
        current_user: "tech1".to_string(),
    })
}

#[tauri::command]
pub fn update_rx_status(
    rx_id: String,
    new_status: RxStatus,
    user_id: Option<String>,
) -> Result<(), String> {
    println!(
        "Rx {} -> {:?} (user: {})",
        rx_id,
        new_status,
        user_id.unwrap_or_else(|| "unknown".to_string())
    );
    Ok(())
}
