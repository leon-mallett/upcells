/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SKIP_LICENSE: string;
  readonly VITE_KEYGEN_ACCOUNT_ID: string;
  readonly VITE_KEYGEN_PRODUCT_ID: string;
  readonly VITE_KEYGEN_PUBLIC_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
