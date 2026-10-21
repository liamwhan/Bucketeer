use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "accounts.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsAccount {
    pub id: String,
    pub label: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    pub label: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreShape {
    #[serde(default)]
    accounts: Vec<AwsAccount>,
}

pub struct AccountsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AccountsStore {
    /// Opens the store in the app data dir, importing `accounts.json` from the
    /// old Electron build's user-data folder on first run so upgrades keep accounts.
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(FILE_NAME);
        if !path.exists() {
            if let Ok(config_dir) = app.path().config_dir() {
                for legacy in ["Bucketeer", "bucketeer"] {
                    let candidate = config_dir.join(legacy).join(FILE_NAME);
                    if candidate.is_file() && fs::copy(&candidate, &path).is_ok() {
                        break;
                    }
                }
            }
        }
        Ok(Self { path, lock: Mutex::new(()) })
    }

    fn read(&self) -> StoreShape {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write(&self, data: &StoreShape) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<AwsAccount> {
        let _g = self.lock.lock().unwrap();
        self.read().accounts
    }

    pub fn get(&self, id: &str) -> Option<AwsAccount> {
        self.list().into_iter().find(|a| a.id == id)
    }

    pub fn add(&self, input: NewAccount) -> Result<AwsAccount, String> {
        let _g = self.lock.lock().unwrap();
        let account = AwsAccount {
            id: uuid::Uuid::new_v4().to_string(),
            label: input.label,
            region: input.region,
            access_key_id: input.access_key_id,
            secret_access_key: input.secret_access_key,
        };
        let mut store = self.read();
        store.accounts.push(account.clone());
        self.write(&store)?;
        Ok(account)
    }

    pub fn update(&self, account: AwsAccount) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut store = self.read();
        let slot = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account.id)
            .ok_or("Account not found")?;
        *slot = account;
        self.write(&store)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut store = self.read();
        store.accounts.retain(|a| a.id != id);
        self.write(&store)
    }
}
