mod commands;
mod data_pool;
mod db;
mod error;
mod export;
mod import;
mod inference;
mod keychain;
mod license;
mod salesforce;
mod sync;

use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Shared cancel handle for the OAuth loopback listener.
/// Holding a `Sender` means an OAuth flow is in progress.
/// Calling `.send(())` drops the listener and releases the port immediately.
pub type OAuthCancelHandle = Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("app data dir unavailable");
            let db_conn = db::open(&data_dir).expect("failed to open database");
            app.manage(db_conn);
            app.manage(OAuthCancelHandle::default());
            app.manage(std::sync::Arc::new(commands::AiState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connections
            commands::list_connections,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::start_salesforce_oauth,
            commands::cancel_oauth,
            commands::test_connection,
            commands::disconnect,
            commands::get_org_stats,
            // License
            commands::get_machine_fingerprint,
            commands::activate_license,
            commands::check_license_status,
            commands::deactivate_license,
            commands::has_stored_license,
            // Queries
            commands::list_sobjects,
            commands::describe_object,
            commands::execute_query,
            commands::list_saved_queries,
            commands::save_query,
            commands::update_saved_query,
            commands::delete_saved_query,
            commands::export_saved_queries_to_file,
            commands::import_saved_queries_from_file,
            // Export
            commands::export_query_results,
            commands::list_export_history,
            // Admin
            commands::analyse_field_population,
            commands::detect_duplicates,
            commands::analyse_record_ownership,
            // Sync (import side)
            commands::read_import_file,
            commands::compute_sync_diff,
            commands::execute_sync,
            commands::list_sync_history,
            // Sales Accelerator (local AI)
            commands::get_ai_hardware_info,
            commands::list_ai_models,
            commands::recommend_ai_model,
            commands::download_ai_model,
            commands::cancel_ai_download,
            commands::load_ai_model,
            commands::generate_ai,
            commands::cancel_ai_generation,
            commands::get_active_ai_model,
            // Data pools (text-to-SQL)
            commands::create_data_pool,
            commands::create_data_pool_from_results,
            commands::list_data_pools,
            commands::delete_data_pool,
            commands::ask_data_pool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Upcells");
}
