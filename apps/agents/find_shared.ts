import { SuiGrpcClient } from "@mysten/sui/grpc";

const OWNER = "0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716";

async function main() {
  const target = process.argv[2] || "0x9fcad467";
  
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io:443",
  });

  console.log(`Searching for objects with prefix: ${target}`);
  let cursor: string | null | undefined;
  do {
    const page = await client.listOwnedObjects({ owner: OWNER, cursor: cursor ?? null, limit: 50 });
    for (const obj of page.objects) {
      const t = obj.type || "";
      if (t.includes(target)) {
        console.log(`${obj.objectId} -> ${t}`);
      }
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

