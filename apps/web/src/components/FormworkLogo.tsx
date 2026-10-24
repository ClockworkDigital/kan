import Image from "next/image";
import Link from "next/link";

export default function FormworkLogo({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="formwork-wordmark text-neutral-900 dark:text-dark-1000"
    >
      FORMWORK
      <Image
        className="formwork-wordmark-icon dark:hidden"
        src="/brand/clockwork-icon-dark.png"
        alt=""
        width={1081}
        height={1080}
        unoptimized
      />
      <Image
        className="formwork-wordmark-icon hidden dark:block"
        src="/brand/clockwork-icon-light.png"
        alt=""
        width={1081}
        height={1080}
        unoptimized
      />
    </Link>
  );
}
