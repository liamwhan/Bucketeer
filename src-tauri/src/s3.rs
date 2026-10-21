use std::{
    collections::{HashMap, HashSet},
    error::Error,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use aws_sdk_s3::{
    config::{BehaviorVersion, Credentials, Region},
    error::DisplayErrorContext,
    primitives::{ByteStream, DateTimeFormat},
    types::{BucketLocationConstraint, ChecksumMode, CreateBucketConfiguration},
    Client,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::accounts::AwsAccount;

const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024;

type Res<T> = Result<T, String>;

fn sdk_err<E: Error>(e: E) -> String {
    DisplayErrorContext(&e).to_string()
}

#[derive(Default)]
pub struct S3State {
    clients: Mutex<HashMap<String, Client>>,
    bucket_regions: Mutex<HashMap<String, String>>,
    preview_dirs: Arc<Mutex<HashSet<PathBuf>>>,
}

// ---- Result shapes (field names match src/shared/types.ts) -------------------

#[derive(Serialize)]
pub struct BucketSummary {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "CreationDate")]
    creation_date: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ListObjectsRow {
    Folder {
        name: String,
        prefix: String,
    },
    File {
        key: String,
        name: String,
        size: Option<i64>,
        #[serde(rename = "lastModified")]
        last_modified: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsPage {
    rows: Vec<ListObjectsRow>,
    is_truncated: bool,
}

#[derive(Serialize)]
pub struct DownloadResult {
    key: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    key: String,
    local_path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPreview {
    key: String,
    temp_path: String,
    content_type: String,
    text: String,
    was_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pdf_base64: Option<String>,
}

#[derive(Serialize)]
pub struct SaveResult {
    key: String,
    #[serde(rename = "eTag")]
    e_tag: Option<String>,
}

// ---- Clients -----------------------------------------------------------------

impl S3State {
    fn client_in_region(&self, account: &AwsAccount, region: &str) -> Client {
        let region = region.trim();
        let cache_key = format!("{}:{}:{}", account.id, region, account.access_key_id);
        let mut clients = self.clients.lock().unwrap();
        clients
            .entry(cache_key)
            .or_insert_with(|| {
                let creds = Credentials::new(
                    account.access_key_id.trim(),
                    account.secret_access_key.clone(),
                    None,
                    None,
                    "bucketeer",
                );
                let conf = aws_sdk_s3::Config::builder()
                    .behavior_version(BehaviorVersion::latest())
                    .region(Region::new(region.to_string()))
                    .credentials_provider(creds)
                    .build();
                Client::from_conf(conf)
            })
            .clone()
    }

    fn client(&self, account: &AwsAccount) -> Client {
        self.client_in_region(account, &account.region)
    }

    async fn client_for_bucket(&self, account: &AwsAccount, bucket: &str) -> Res<Client> {
        let cache_key = format!("{}:{}", account.id, bucket);
        let cached = self.bucket_regions.lock().unwrap().get(&cache_key).cloned();
        let region = match cached {
            Some(r) => r,
            None => {
                let out = self
                    .client(account)
                    .get_bucket_location()
                    .bucket(bucket)
                    .send()
                    .await
                    .map_err(sdk_err)?;
                let region = match out.location_constraint().map(|l| l.as_str()) {
                    None | Some("") => "us-east-1".to_string(),
                    Some("EU") => "eu-west-1".to_string(),
                    Some(r) => r.to_string(),
                };
                self.bucket_regions
                    .lock()
                    .unwrap()
                    .insert(cache_key, region.clone());
                region
            }
        };
        Ok(self.client_in_region(account, &region))
    }

    pub fn clear_client_cache(&self, account_id: &str) {
        let prefix = format!("{account_id}:");
        self.clients.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
        self.bucket_regions
            .lock()
            .unwrap()
            .retain(|k, _| !k.starts_with(&prefix));
    }

    /// Removes every preview temp folder that is still on disk (called on exit).
    pub fn cleanup_preview_cache(&self) {
        let dirs: Vec<PathBuf> = self.preview_dirs.lock().unwrap().drain().collect();
        for d in dirs {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    fn schedule_preview_cleanup(&self, dir: PathBuf) {
        self.preview_dirs.lock().unwrap().insert(dir.clone());
        let dirs = self.preview_dirs.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PREVIEW_TTL).await;
            let _ = tokio::fs::remove_dir_all(&dir).await;
            dirs.lock().unwrap().remove(&dir);
        });
    }

    // ---- Operations ----------------------------------------------------------

    pub async fn list_buckets(&self, account: &AwsAccount) -> Res<Vec<BucketSummary>> {
        let out = self.client(account).list_buckets().send().await.map_err(sdk_err)?;
        Ok(out
            .buckets()
            .iter()
            .map(|b| BucketSummary {
                name: b.name().map(str::to_string),
                creation_date: b
                    .creation_date()
                    .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()),
            })
            .collect())
    }

    /// CreateBucket: us-east-1 must omit LocationConstraint; all other regions require it.
    pub async fn create_bucket(&self, account: &AwsAccount, bucket_name: &str) -> Res<()> {
        let region = account.region.trim();
        let name = bucket_name.trim();
        if name.is_empty() {
            return Err("Bucket name is required".into());
        }
        let mut req = self.client(account).create_bucket().bucket(name);
        if region != "us-east-1" {
            req = req.create_bucket_configuration(
                CreateBucketConfiguration::builder()
                    .location_constraint(BucketLocationConstraint::from(region))
                    .build(),
            );
        }
        req.send().await.map_err(sdk_err)?;
        Ok(())
    }

    pub async fn list_objects(
        &self,
        account: &AwsAccount,
        bucket: &str,
        prefix: &str,
    ) -> Res<ListObjectsPage> {
        let client = self.client_for_bucket(account, bucket).await?;
        let mut rows = Vec::new();
        let mut seen_folders = HashSet::new();
        let mut seen_files = HashSet::new();
        let mut token: Option<String> = None;
        let mut is_truncated;

        loop {
            let res = client
                .list_objects_v2()
                .bucket(bucket)
                .prefix(prefix)
                .delimiter("/")
                .set_continuation_token(token.take())
                .send()
                .await
                .map_err(sdk_err)?;

            for cp in res.common_prefixes() {
                let p = cp.prefix().unwrap_or_default();
                if p.is_empty() || seen_folders.contains(p) {
                    continue;
                }
                let base = p.strip_suffix('/').unwrap_or(p);
                let name = base.rsplit('/').next().unwrap_or(base);
                if !name.is_empty() {
                    rows.push(ListObjectsRow::Folder {
                        name: name.to_string(),
                        prefix: p.to_string(),
                    });
                    seen_folders.insert(p.to_string());
                }
            }

            for obj in res.contents() {
                let key = obj.key().unwrap_or_default();
                if key.is_empty() || key == prefix || seen_files.contains(key) {
                    continue;
                }
                let relative = key.strip_prefix(prefix).unwrap_or(key);
                if relative.is_empty() || relative.contains('/') {
                    continue;
                }
                rows.push(ListObjectsRow::File {
                    key: key.to_string(),
                    name: relative.to_string(),
                    size: obj.size(),
                    last_modified: obj
                        .last_modified()
                        .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()),
                });
                seen_files.insert(key.to_string());
            }

            is_truncated = res.is_truncated().unwrap_or(false);
            token = res.next_continuation_token().map(str::to_string);
            if token.is_none() {
                break;
            }
        }

        rows.sort_by(|a, b| {
            let rank = |r: &ListObjectsRow| matches!(r, ListObjectsRow::File { .. }) as u8;
            let name = |r: &ListObjectsRow| match r {
                ListObjectsRow::Folder { name, .. } | ListObjectsRow::File { name, .. } => {
                    name.to_lowercase()
                }
            };
            rank(a).cmp(&rank(b)).then_with(|| name(a).cmp(&name(b)))
        });

        Ok(ListObjectsPage { rows, is_truncated })
    }

    pub async fn download_objects(
        &self,
        account: &AwsAccount,
        bucket: &str,
        keys: &[String],
        dest_dir: &Path,
    ) -> Res<Vec<DownloadResult>> {
        let client = self.client_for_bucket(account, bucket).await?;
        let mut results = Vec::with_capacity(keys.len());
        for key in keys {
            results.push(match download_one(&client, bucket, key, dest_dir).await {
                Ok(path) => DownloadResult {
                    key: key.clone(),
                    ok: true,
                    path: Some(path.to_string_lossy().into_owned()),
                    error: None,
                },
                Err(e) => DownloadResult {
                    key: key.clone(),
                    ok: false,
                    path: None,
                    error: Some(e),
                },
            });
        }
        Ok(results)
    }

    /// Rename = copy to a new key under the same parent prefix, then delete the original.
    /// Single-part copy only (objects larger than 5 GB are not supported).
    pub async fn rename_object(
        &self,
        account: &AwsAccount,
        bucket: &str,
        source_key: &str,
        new_file_name: &str,
    ) -> Res<serde_json::Value> {
        let segment = new_file_name.trim();
        if segment.is_empty() {
            return Err("New name is required".into());
        }
        if segment.contains('/') || segment.contains('\\') {
            return Err("Object name cannot contain path separators".into());
        }
        let parent = source_key.rfind('/').map_or("", |i| &source_key[..=i]);
        let new_key = format!("{parent}{segment}");
        if new_key == source_key {
            return Ok(serde_json::json!({ "newKey": new_key }));
        }

        let client = self.client_for_bucket(account, bucket).await?;
        client
            .copy_object()
            .bucket(bucket)
            .key(&new_key)
            .copy_source(format!("{bucket}/{}", encode_uri_component(source_key)))
            .send()
            .await
            .map_err(sdk_err)?;

        if let Err(e) = client.delete_object().bucket(bucket).key(source_key).send().await {
            return Err(format!(
                "Object was copied to \"{new_key}\" but deleting the original failed: {}",
                sdk_err(e)
            ));
        }
        Ok(serde_json::json!({ "newKey": new_key }))
    }

    /// Folders in S3 are a UI convention: an empty object whose key ends with `/`.
    pub async fn create_folder(
        &self,
        account: &AwsAccount,
        bucket: &str,
        prefix: &str,
        folder_name: &str,
    ) -> Res<serde_json::Value> {
        let segment = folder_name.trim().trim_end_matches('/');
        if segment.is_empty() {
            return Err("Folder name is required".into());
        }
        if segment.contains('/') || segment.contains('\\') {
            return Err("Folder name cannot contain path separators".into());
        }
        let key = format!("{}{segment}/", normalize_prefix(prefix));
        let client = self.client_for_bucket(account, bucket).await?;
        client
            .put_object()
            .bucket(bucket)
            .key(&key)
            .body(ByteStream::from_static(b""))
            .send()
            .await
            .map_err(sdk_err)?;
        Ok(serde_json::json!({ "key": key }))
    }

    /// Uploads local files under the current prefix (object key = prefix + basename).
    pub async fn upload_local_files(
        &self,
        account: &AwsAccount,
        bucket: &str,
        prefix: &str,
        local_paths: &[String],
    ) -> Res<Vec<UploadResult>> {
        let normalized = normalize_prefix(prefix);
        let client = self.client_for_bucket(account, bucket).await?;
        let mut results = Vec::with_capacity(local_paths.len());

        for local in local_paths {
            let name = Path::new(local)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let key = format!("{normalized}{name}");
            let outcome = async {
                if name.is_empty() || name == "." || name == ".." {
                    return Err("Invalid file path".to_string());
                }
                let meta = tokio::fs::metadata(local).await.map_err(|e| e.to_string())?;
                if !meta.is_file() {
                    return Err("Not a file (folders are not uploaded)".to_string());
                }
                let body = ByteStream::from_path(local).await.map_err(|e| e.to_string())?;
                client
                    .put_object()
                    .bucket(bucket)
                    .key(&key)
                    .body(body)
                    .content_type(content_type_from_name(local))
                    .send()
                    .await
                    .map_err(sdk_err)?;
                Ok(())
            }
            .await;
            results.push(UploadResult {
                key,
                local_path: local.clone(),
                ok: outcome.is_ok(),
                error: outcome.err(),
            });
        }
        Ok(results)
    }

    pub async fn get_object_preview(
        &self,
        account: &AwsAccount,
        bucket: &str,
        key: &str,
    ) -> Res<ObjectPreview> {
        let client = self.client_for_bucket(account, bucket).await?;
        let tmp_dir = std::env::temp_dir().join(format!("bucketeer-preview-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&tmp_dir).await.map_err(|e| e.to_string())?;
        // Registered up front so it is also removed on exit if anything below fails.
        self.schedule_preview_cleanup(tmp_dir.clone());

        let file_name = key.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("preview.txt");
        let temp_path = tmp_dir.join(file_name);

        let res = client
            .get_object()
            .bucket(bucket)
            .key(key)
            .range(format!("bytes=0-{}", PREVIEW_MAX_BYTES - 1))
            .send()
            .await
            .map_err(sdk_err)?;
        let s3_content_type = res.content_type().map(str::to_string);
        let content_range = res.content_range().unwrap_or_default().to_string();
        let raw = res.body.collect().await.map_err(|e| e.to_string())?.into_bytes();

        let content_type = resolve_preview_content_type(s3_content_type.as_deref(), key, &raw);
        let is_pdf = content_type.to_lowercase().contains("application/pdf");
        let text = if is_pdf { String::new() } else { String::from_utf8_lossy(&raw).into_owned() };

        let total_bytes = content_range
            .rsplit('/')
            .next()
            .and_then(|t| t.parse::<usize>().ok());
        let was_truncated = match total_bytes {
            Some(total) => total > PREVIEW_MAX_BYTES,
            None => raw.len() >= PREVIEW_MAX_BYTES,
        };
        if was_truncated {
            return Err(format!(
                "Preview is limited to {} MB.",
                (PREVIEW_MAX_BYTES as f64 / (1024.0 * 1024.0)).round()
            ));
        }

        let mut shown = text;
        if content_type.contains("application/json") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&shown) {
                if let Ok(pretty) = serde_json::to_string_pretty(&value) {
                    shown = pretty;
                }
            }
        }
        // The temp copy holds what the preview shows (pretty-printed JSON or raw bytes).
        let on_disk: &[u8] = if is_pdf || !content_type.contains("application/json") {
            &raw
        } else {
            shown.as_bytes()
        };
        tokio::fs::write(&temp_path, on_disk).await.map_err(|e| e.to_string())?;

        Ok(ObjectPreview {
            key: key.to_string(),
            temp_path: temp_path.to_string_lossy().into_owned(),
            content_type,
            text: shown,
            was_truncated,
            pdf_base64: is_pdf.then(|| B64.encode(&raw)),
        })
    }

    pub async fn put_object_text(
        &self,
        account: &AwsAccount,
        bucket: &str,
        key: &str,
        text: String,
        content_type: &str,
    ) -> Res<SaveResult> {
        let client = self.client_for_bucket(account, bucket).await?;
        let out = client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(text.into_bytes()))
            .send()
            .await
            .map_err(sdk_err)?;
        Ok(SaveResult { key: key.to_string(), e_tag: out.e_tag().map(str::to_string) })
    }
}

// ---- Helpers -----------------------------------------------------------------

fn normalize_prefix(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

/// Mirrors JavaScript's encodeURIComponent (S3 CopySource wants the key fully encoded).
fn encode_uri_component(s: &str) -> String {
    const KEEP: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(s, KEEP).to_string()
}

fn content_type_from_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        "application/yaml"
    } else if lower.ends_with(".xml") {
        "application/xml"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

fn resolve_preview_content_type(s3_content_type: Option<&str>, key: &str, raw: &[u8]) -> String {
    let normalized = s3_content_type.unwrap_or("").trim().to_lowercase();
    if normalized.is_empty() {
        return content_type_from_name(key).to_string();
    }
    // Recover richer type metadata when S3 returns generic binary content.
    if normalized.contains("application/octet-stream") {
        if raw.starts_with(b"%PDF-") || key.to_lowercase().ends_with(".pdf") {
            return "application/pdf".to_string();
        }
        let inferred = content_type_from_name(key);
        if inferred != "application/octet-stream" {
            return inferred.to_string();
        }
    }
    s3_content_type.unwrap_or_default().to_string()
}

fn safe_download_path(dest_dir: &Path, key: &str) -> Res<PathBuf> {
    let normalized = key.trim();
    if normalized.is_empty() {
        return Err("Object key cannot be empty".into());
    }
    if normalized.contains('\\') {
        return Err(format!("Object key \"{key}\" contains unsupported path separators"));
    }
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(format!("Object key \"{key}\" does not map to a file path"));
    }
    let mut target = dest_dir.to_path_buf();
    for part in parts {
        if part == "." || part == ".." {
            return Err(format!("Object key \"{key}\" contains path traversal segments"));
        }
        if part.contains('\0') {
            return Err(format!("Object key \"{key}\" contains invalid characters"));
        }
        let mut chars = part.chars();
        let drive_prefix = matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic());
        if drive_prefix || Path::new(part).is_absolute() {
            return Err(format!("Object key \"{key}\" contains an absolute path segment"));
        }
        target.push(part);
    }
    if !target.starts_with(dest_dir) {
        return Err(format!("Object key \"{key}\" resolves outside the destination folder"));
    }
    Ok(target)
}

async fn download_one(client: &Client, bucket: &str, key: &str, dest_dir: &Path) -> Res<PathBuf> {
    let target = safe_download_path(dest_dir, key)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let mut res = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .checksum_mode(ChecksumMode::Enabled)
        .send()
        .await
        .map_err(sdk_err)?;
    let expected_len = res.content_length();
    let expected_sha = res.checksum_sha256().map(|s| s.trim().to_string());

    let streamed = async {
        let mut file = tokio::fs::File::create(&target).await.map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = res.body.try_next().await.map_err(|e| e.to_string())? {
            hasher.update(&chunk);
            written += chunk.len() as u64;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())?;

        if let Some(expected) = expected_len.filter(|n| *n >= 0) {
            if written != expected as u64 {
                return Err(format!(
                    "Downloaded size mismatch: expected {expected} bytes but wrote {written} bytes"
                ));
            }
        }
        // A "-N" suffix marks a checksum-of-checksums for multipart uploads, which can't be recomputed here.
        if let Some(expected) = expected_sha.filter(|s| !s.is_empty() && !s.contains('-')) {
            if B64.encode(hasher.finalize()) != expected {
                return Err("Downloaded content checksum verification failed".to_string());
            }
        }
        Ok(())
    }
    .await;

    if let Err(e) = streamed {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(e);
    }
    Ok(target)
}
