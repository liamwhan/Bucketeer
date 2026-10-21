#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod s3;

use accounts::{AccountsStore, AwsAccount, NewAccount};
use s3::{
    BucketSummary, DownloadResult, ListObjectsPage, ObjectPreview, S3State, SaveResult,
    UploadResult,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const RELEASES_URL_PREFIX: &str = "https://github.com/liamwhan/Bucketeer/releases";
const ALLOWED_EXTERNAL_SCHEMES: [&str; 2] = ["https", "mailto"];

type Res<T> = Result<T, String>;

fn assert_string(value: &str, field: &str) -> Res<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(trimmed.to_string())
}

fn assert_string_array(values: &[String], field: &str) -> Res<Vec<String>> {
    if values.is_empty() {
        return Err(format!("{field} must include at least one item"));
    }
    values
        .iter()
        .enumerate()
        .map(|(i, v)| assert_string(v, &format!("{field}[{i}]")))
        .collect()
}

fn account_or_err(store: &AccountsStore, id: &str) -> Res<AwsAccount> {
    let id = assert_string(id, "accountId")?;
    store.get(&id).ok_or_else(|| "Unknown account".to_string())
}

// ---- App ---------------------------------------------------------------------

#[tauri::command]
fn app_open_release_page(app: AppHandle, url: String) -> Res<()> {
    if !url.starts_with(RELEASES_URL_PREFIX) {
        return Err("Refusing to open a non-release URL".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Opens https:/mailto: links from the webview in the system browser.
#[tauri::command]
fn app_open_external(app: AppHandle, url: String) -> Res<()> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !ALLOWED_EXTERNAL_SCHEMES.contains(&parsed.scheme()) {
        return Err("Unsupported URL scheme".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// ---- Accounts ----------------------------------------------------------------

#[tauri::command]
fn accounts_list(store: State<'_, AccountsStore>) -> Vec<AwsAccount> {
    store.list()
}

#[tauri::command]
fn accounts_add(store: State<'_, AccountsStore>, input: NewAccount) -> Res<AwsAccount> {
    store.add(NewAccount {
        label: assert_string(&input.label, "label")?,
        access_key_id: assert_string(&input.access_key_id, "accessKeyId")?,
        secret_access_key: assert_string(&input.secret_access_key, "secretAccessKey")?,
        region: assert_string(&input.region, "region")?,
    })
}

#[tauri::command]
fn accounts_update(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account: AwsAccount,
) -> Res<()> {
    let next = AwsAccount {
        id: assert_string(&account.id, "id")?,
        label: assert_string(&account.label, "label")?,
        access_key_id: assert_string(&account.access_key_id, "accessKeyId")?,
        secret_access_key: assert_string(&account.secret_access_key, "secretAccessKey")?,
        region: assert_string(&account.region, "region")?,
    };
    let id = next.id.clone();
    store.update(next)?;
    s3.clear_client_cache(&id);
    Ok(())
}

#[tauri::command]
fn accounts_remove(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    id: String,
) -> Res<()> {
    let id = assert_string(&id, "accountId")?;
    store.remove(&id)?;
    s3.clear_client_cache(&id);
    Ok(())
}

// ---- S3 ----------------------------------------------------------------------

#[tauri::command]
async fn s3_list_buckets(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
) -> Res<Vec<BucketSummary>> {
    let account = account_or_err(&store, &account_id)?;
    s3.list_buckets(&account).await
}

#[tauri::command]
async fn s3_create_bucket(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket_name: String,
) -> Res<()> {
    let account = account_or_err(&store, &account_id)?;
    s3.create_bucket(&account, &assert_string(&bucket_name, "bucketName")?).await
}

#[tauri::command]
async fn s3_list_objects(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    prefix: Option<String>,
) -> Res<ListObjectsPage> {
    let account = account_or_err(&store, &account_id)?;
    s3.list_objects(&account, &assert_string(&bucket, "bucket")?, &prefix.unwrap_or_default())
        .await
}

#[tauri::command]
async fn s3_pick_download_dir(window: WebviewWindow) -> Res<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn s3_download_objects(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    keys: Vec<String>,
    dest_dir: String,
) -> Res<Vec<DownloadResult>> {
    let account = account_or_err(&store, &account_id)?;
    let bucket = assert_string(&bucket, "bucket")?;
    let keys = assert_string_array(&keys, "keys")?;
    let dest = std::path::PathBuf::from(assert_string(&dest_dir, "destDir")?);
    if !tokio::fs::metadata(&dest).await.map_err(|e| e.to_string())?.is_dir() {
        return Err("destDir must be a directory".into());
    }
    s3.download_objects(&account, &bucket, &keys, &dest).await
}

#[tauri::command]
async fn s3_rename_object(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    source_key: String,
    new_file_name: String,
) -> Res<serde_json::Value> {
    let account = account_or_err(&store, &account_id)?;
    s3.rename_object(
        &account,
        &assert_string(&bucket, "bucket")?,
        &assert_string(&source_key, "sourceKey")?,
        &assert_string(&new_file_name, "newFileName")?,
    )
    .await
}

#[tauri::command]
async fn s3_create_folder(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    prefix: Option<String>,
    folder_name: String,
) -> Res<serde_json::Value> {
    let account = account_or_err(&store, &account_id)?;
    s3.create_folder(
        &account,
        &assert_string(&bucket, "bucket")?,
        &prefix.unwrap_or_default(),
        &assert_string(&folder_name, "folderName")?,
    )
    .await
}

#[tauri::command]
async fn s3_upload_local_files(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    prefix: Option<String>,
    local_paths: Vec<String>,
) -> Res<Vec<UploadResult>> {
    let account = account_or_err(&store, &account_id)?;
    s3.upload_local_files(
        &account,
        &assert_string(&bucket, "bucket")?,
        &prefix.unwrap_or_default(),
        &assert_string_array(&local_paths, "localPaths")?,
    )
    .await
}

#[tauri::command]
async fn s3_get_object_preview(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    key: String,
) -> Res<ObjectPreview> {
    let account = account_or_err(&store, &account_id)?;
    s3.get_object_preview(&account, &assert_string(&bucket, "bucket")?, &assert_string(&key, "key")?)
        .await
}

#[tauri::command]
async fn s3_put_object_text(
    store: State<'_, AccountsStore>,
    s3: State<'_, S3State>,
    account_id: String,
    bucket: String,
    key: String,
    text: String,
    content_type: String,
) -> Res<SaveResult> {
    let account = account_or_err(&store, &account_id)?;
    s3.put_object_text(
        &account,
        &assert_string(&bucket, "bucket")?,
        &assert_string(&key, "key")?,
        text,
        &assert_string(&content_type, "contentType")?,
    )
    .await
}

// ---- Menu --------------------------------------------------------------------

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let is_mac = cfg!(target_os = "macos");
    let about = MenuItem::with_id(app, "about", "About Bucketeer", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "checkForUpdates", "Check for Updates…", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);

    let file_item = if is_mac {
        PredefinedMenuItem::close_window(app, None)?
    } else {
        PredefinedMenuItem::quit(app, None)?
    };
    let file = Submenu::with_items(app, "File", true, &[&file_item])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = if is_mac {
        Submenu::with_items(app, "Help", true, &[&updates])?
    } else {
        Submenu::with_items(app, "Help", true, &[&updates, &sep()?, &about])?
    };

    if is_mac {
        let app_menu = Submenu::with_items(
            app,
            "Bucketeer",
            true,
            &[
                &about,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
    } else {
        Menu::with_items(app, &[&file, &edit, &view, &window, &help])
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(S3State::default())
        .setup(|app| {
            let store = AccountsStore::open(app.handle())?;
            app.manage(store);
            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "about" || id == "checkForUpdates" {
                let _ = app.emit("menu-action", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_open_release_page,
            app_open_external,
            accounts_list,
            accounts_add,
            accounts_update,
            accounts_remove,
            s3_list_buckets,
            s3_create_bucket,
            s3_list_objects,
            s3_pick_download_dir,
            s3_download_objects,
            s3_rename_object,
            s3_create_folder,
            s3_upload_local_files,
            s3_get_object_preview,
            s3_put_object_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bucketeer");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<S3State>().cleanup_preview_cache();
        }
    });
}
