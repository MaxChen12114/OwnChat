#!/usr/bin/env node
// scripts/fetch-model.mjs — 把向量模型拉到 public/models/（不进 git）
// ─────────────────────────────────────────────────────────────────
// 为什么要有这一步：
//   43MB 二进制不进仓库（clone 体积、Cloudflare 单文件 25MiB 上限、换语言模型就得发版）。
//   但"想要向量腿"的人应该一条命令就能用上，所以把下载动作固化成脚本。
//
// 拉什么：
//   public/models/Xenova/bge-small-zh-v1.5/   中文嵌入模型（量化 24MB）+ tokenizer
//   public/models/tf/                         transformers.js 自带的 webpack 包 + onnxruntime wasm
//
// 换语言：改 MODEL 常量即可（英文 bge-small-en-v1.5；多语 bge-m3 大得多）。
//
// 用法：node scripts/fetch-model.mjs [--force]
// ─────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "models");
const FORCE = process.argv.includes("--force");

// huggingface.co 在部分网络不可达，用镜像；可用 HF_ENDPOINT 覆盖
const HF = (process.env.HF_ENDPOINT || "https://hf-mirror.com").replace(/\/+$/, "");
const NPM = (process.env.NPM_MIRROR || "https://registry.npmmirror.com").replace(/\/+$/, "");
const MODEL = process.env.MEM_MODEL || "Xenova/bge-small-zh-v1.5";
const TF_VER = "2.17.2";
const ORT_VER = "1.14.0";

async function dl(url, dest) {
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log("  · 已存在，跳过 " + path.relative(ROOT, dest));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const t0 = Date.now();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error("下载失败 " + res.status + " " + url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log("  ✓ " + path.relative(ROOT, dest) + "  " + (buf.length / 1024 / 1024).toFixed(1) + "MB  " +
    ((Date.now() - t0) / 1000).toFixed(1) + "s");
}

async function main() {
  console.log("[fetch-model] 输出目录 " + OUT);
  console.log("[fetch-model] 模型 " + MODEL);

  // ① 模型本体（HF 布局：config / tokenizer / onnx）
  const files = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
  for (const f of files) {
    await dl(HF + "/" + MODEL + "/resolve/main/" + f, path.join(OUT, MODEL, f));
  }

  // ② transformers.js 的 webpack 包（自带 onnxruntime-web，无裸 import，浏览器可直接 import）
  const tfOut = path.join(OUT, "tf");
  if (!FORCE && fs.existsSync(path.join(tfOut, "transformers.min.js")) && fs.existsSync(path.join(tfOut, "ort-wasm-simd.wasm"))) {
    console.log("  · 已存在，跳过 public/models/tf/");
    console.log("[fetch-model] 完成。");
    return;
  }
  const tmp = path.join(ROOT, ".tmp-fetch-model");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const tgz = path.join(tmp, "tf.tgz");
  console.log("[fetch-model] 取 @xenova/transformers@" + TF_VER);
  const r1 = await fetch(NPM + "/@xenova/transformers/-/transformers-" + TF_VER + ".tgz");
  if (!r1.ok) throw new Error("npm 包下载失败 " + r1.status);
  fs.writeFileSync(tgz, Buffer.from(await r1.arrayBuffer()));
  // 用系统 tar 解包（Windows 10+ 自带）
  const { execFileSync } = await import("node:child_process");
  // Windows 的 tar 会把 "C:\..." 当成远端规格，所以用 cwd + 相对文件名
  execFileSync("tar", ["-xzf", "tf.tgz"], { cwd: tmp, stdio: "ignore" });
  const dist = path.join(tmp, "package", "dist");
  fs.mkdirSync(tfOut, { recursive: true });
  fs.copyFileSync(path.join(dist, "transformers.min.js"), path.join(tfOut, "transformers.min.js"));
  // 只保留 simd / plain 两个 wasm：threaded 版要 COOP/COEP 头，浏览器里用不到
  for (const w of ["ort-wasm-simd.wasm", "ort-wasm.wasm"]) {
    const src = path.join(dist, w);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tfOut, w));
  }
  console.log("  ✓ public/models/tf/transformers.min.js + " + ORT_VER + " wasm");
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("[fetch-model] 完成。向量腿会自动启用（public/models/ 存在即可）。");
}

main().catch((e) => { console.error("[fetch-model] 失败：" + (e && e.message || e)); process.exit(1); });
