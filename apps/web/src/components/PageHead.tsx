import Head from "next/head";
import { env } from "next-runtime-env";

export const PageHead = ({ title }: { title: string }) => {
  return (
    <Head>
      <title>{title}</title>
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, maximum-scale=1"
      />
      <link rel="manifest" href="/manifest.json" />
      {env("NEXT_PUBLIC_FORMWORK_URL") && (
        <link
          rel="icon"
          type="image/png"
          href="/brand/clockwork-icon-dark.png"
        />
      )}
    </Head>
  );
};
