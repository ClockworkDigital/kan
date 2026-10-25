import { Head, Html, Main, NextScript } from "next/document";
import Script from "next/script";

export default function Document() {
  return (
    <Html>
      <Head>
        <Script src="/__ENV.js" strategy="beforeInteractive" defer={false} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
