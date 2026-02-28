use tauri::Manager;

mod db;
mod commands;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Drug tree DB (read-only FDA data)
            let resource_path = app.path()
                .resolve("resources/drug_tree.db", tauri::path::BaseDirectory::Resource)
                .expect("failed to resolve drug_tree.db path");

            db::init(&resource_path.to_string_lossy())
                .expect("failed to initialize drug database");

            // Inventory DB (writable, in app data dir)
            let app_data = app.path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data).ok();
            let inv_path = app_data.join("inventory.db");

            commands::inventory::init_inventory(&inv_path.to_string_lossy())
                .expect("failed to initialize inventory database");

            println!("PharmIDE backend ready.");
            println!("  Drug DB: {:?}", resource_path);
            println!("  Inventory DB: {:?}", inv_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Drug tree commands
            commands::drug_search::search_drugs,
            commands::drug_search::get_strengths,
            commands::drug_search::get_forms,
            commands::drug_search::get_products,
            commands::drug_search::get_dispensable_products,
            commands::drug_search::get_drug_dispensable_products,
            commands::drug_search::lookup_ndc,
            commands::drug_search::get_drug_tree,
            // Structured search
            commands::drug_search::search_clinical_products,
            commands::drug_search::search_drugs_fast,
            commands::drug_search::get_drug_names,
            commands::drug_search::get_dose_options,
            commands::drug_search::get_form_options,
            // Inventory
            commands::inventory::get_inventory,
            commands::inventory::get_inventory_batch,
            commands::inventory::update_inventory,
            commands::inventory::adjust_on_hand,
            // Queue
            commands::queue::get_queue_state,
            commands::queue::update_rx_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PharmIDE");
}
