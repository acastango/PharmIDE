use tauri::Manager;

mod app_db;
mod db;
mod commands;
mod models;
mod sys_clock;

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

            let pharmide_path = app_data.join("pharmide.db");
            app_db::init(&pharmide_path.to_string_lossy())
                .expect("failed to open app database");
            commands::rx_engine::init_pharmide_db()
                .expect("failed to initialize app schema");

            println!("PharmIDE backend ready.");
            println!("  Drug DB: {:?}", resource_path);
            println!("  Inventory DB: {:?}", inv_path);
            println!("  App DB: {:?}", pharmide_path);
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
            // Rx Engine
            commands::rx_engine::create_prescription,
            commands::rx_engine::transition_rx,
            commands::rx_engine::get_prescription,
            commands::rx_engine::get_prescriptions_by_patient,
            commands::rx_engine::get_prescriptions_by_status,
            commands::rx_engine::get_active_prescriptions,
            commands::rx_engine::get_all_prescriptions,
            commands::rx_engine::get_queue_counts,
            commands::rx_engine::get_events_by_rx,
            commands::rx_engine::get_events_by_date_range,
            commands::rx_engine::get_users,
            commands::rx_engine::start_session,
            commands::rx_engine::end_session,
            commands::rx_engine::verify_audit_chain,
            // Patients
            commands::patients::get_patient,
            commands::patients::upsert_patient,
            commands::patients::get_all_patients,
            commands::patients::search_patients,
            // AI
            commands::ai::generate_escripts,
            // E-Orders
            commands::rx_engine::ingest_eorder_xml,
            commands::rx_engine::get_all_eorders,
            commands::rx_engine::get_eorder_by_patient,
            commands::rx_engine::mark_eorder_resolved,
            // Prescribers
            commands::rx_engine::get_all_prescribers,
            commands::rx_engine::get_prescriber,
            commands::rx_engine::search_prescribers_db,
            commands::rx_engine::upsert_prescriber,
            // Fill History
            commands::rx_engine::append_fill_history,
            commands::rx_engine::get_fill_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PharmIDE");
}
