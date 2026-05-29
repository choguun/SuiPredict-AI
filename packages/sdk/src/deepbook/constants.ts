/** DeepBook V3 testnet constants */
export const DEEPBOOK_PACKAGE_ID =
  "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";

export const DEEPBOOK_REGISTRY_ID =
  "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";

export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export const DEEP_TYPE =
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";

export const VLP_TYPE =
  process.env.MARKET_PACKAGE_ID
    ? `${process.env.MARKET_PACKAGE_ID}::vlp::VLP`
    : "0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8::vlp::VLP";

export const POOL_SUI_DBUSDC = "SUI_DBUSDC";
export const POOL_DEEP_DBUSDC = "DEEP_DBUSDC";

export const POOL_CREATION_FEE_DEEP = 500_000_000n;
