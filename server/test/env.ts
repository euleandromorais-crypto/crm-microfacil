// variáveis de ambiente dos testes (antes de importar a configuração)
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_test';
process.env.APP_ENCRYPTION_KEY = 'test-key-0123456789abcdef0123456789abcdef';
process.env.APP_URL = 'http://localhost:3000';
process.env.STORAGE_DIR = '/tmp/crm-test-storage';
process.env.META_GRAPH_URL = process.env.META_GRAPH_URL ?? 'http://127.0.0.1:47011';
process.env.RUN_WORKER_IN_PROCESS = 'false';
