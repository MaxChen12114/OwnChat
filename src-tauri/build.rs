fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "ping",
                "open_external",
                // 2026-10-07 域中立壳：启动页读写服务器地址（授权/导航在 Rust 侧一并完成）
                "get_server_url",
                "set_server_url",
                "read_text_file",
                "import_text_file",
                "export_text_file",
                "get_storage_dir",
                "set_storage_dir",
                "pick_storage_dir",
                "open_storage_dir",
                "kv_set",
                "kv_get",
                "kv_list",
                "kv_delete",
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
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}