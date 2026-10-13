// Deterministic external renderer result; real CLI image output is covered by E2E.
process.stdout.write(JSON.stringify({images: [{path: 'preview/page-1.png'}]}) + '\n');
