console.error('Automatic/CLI startup is disabled. The guarded local test is available through npm run start:local only after approved setup and private credential entry. Do not run slack login/install/run/deploy outside the approved scope.');
process.exitCode = 1;
