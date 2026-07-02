use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    pub fn db(message: impl ToString) -> Self {
        Self::new("DB_ERROR", message)
    }

    pub fn keychain(message: impl ToString) -> Self {
        Self::new("KEYCHAIN_ERROR", message)
    }

    pub fn auth(message: impl ToString) -> Self {
        Self::new("AUTH_ERROR", message)
    }

    pub fn api(message: impl ToString) -> Self {
        Self::new("API_ERROR", message)
    }

    pub fn license(message: impl ToString) -> Self {
        Self::new("LICENSE_ERROR", message)
    }

    pub fn io(message: impl ToString) -> Self {
        Self::new("IO_ERROR", message)
    }

    pub fn validation(message: impl ToString) -> Self {
        Self::new("VALIDATION_ERROR", message)
    }

    pub fn inference(message: impl ToString) -> Self {
        Self::new("INFERENCE_ERROR", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

pub type AppResult<T> = Result<T, AppError>;
