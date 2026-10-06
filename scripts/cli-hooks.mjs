process.stdout.write(JSON.stringify({
  hooks: {
    'get-manifest': 'node scripts/print-manifest.mjs',
    build: 'npm run build',
    start: 'node scripts/runtime-disabled.mjs',
    deploy: 'node scripts/runtime-disabled.mjs'
  },
  config: { 'sdk-managed-connection-enabled': true }
}));
