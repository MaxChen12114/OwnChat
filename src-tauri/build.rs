fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "ping",
                "open_external",
                "open_panel_window",
                "close_panel_window",
                // 2026-10-07 域中立壳：读写宿主地址（T4-B 起只存基址，不再导航/动态授权）
                "get_server_url",
                "set_server_url",
                // 2026-11-28（T4-B）：首启向导「使用本机密码」——读 sidecar 首跑生成的那份文件
                "host_admin_password",
                "read_text_file",
                "import_text_file",
                "export_text_file",
                "export_binary_file",
                "get_storage_dir",
                "set_storage_dir",
                "pick_storage_dir",
                "open_storage_dir",
                "kv_set",
                "kv_get",
                "kv_list",
                "kv_delete",
                // 2026-11-28（T2 提供、T4-B 补登记）：统一存储的桌面三命令。T2 只加进了
                // generate_handler 与 db.rs，漏了本清单 —— 没有 allow-db-* 权限，
                // capabilities/default.json 授权会直接构建失败，桌面 db adapter 也调不到。
                "db_migrate",
                "db_exec",
                "db_tx",
                "http_request",
                "http_request_stream",
                "tts_get_config",
                "tts_set_config",
                "tts_start",
                "tts_stop",
                "tts_pick_dir",
                "tts_list_models",
                "tts_pick_file",
                "tts_pick_files",
                // 2026-10-05: agent_local.rs 的 8 条命令(4.70 本地能力)。
                // 不在这里登记 → tauri-build 不生成对应 allow-* 权限 → 远程源在
                // capabilities 里想授也没得授,命令对远程页完全不可达。
                // (先例:d896eb3 给 ping 补登记 + allow-ping;"register tts_* commands
                //  in build manifest for ACL generation")
                "agent_workdir_get",
                "agent_workdir_pick",
                "agent_workdir_set",
                "local_list_dir",
                "local_read_file",
                "local_write_file",
                "local_run_command",
                "local_env_info",
                // 4.72 本地服务管家（services.rs）：随 App 启停/重启本机服务
                "svc_list",
                "svc_set_enabled",
                "svc_start",
                "svc_stop",
                "svc_restart",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}