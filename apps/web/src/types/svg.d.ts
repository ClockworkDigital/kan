declare module "*.svg" {
  import type { FC, SVGProps } from "react";

  const Svg: FC<SVGProps<SVGSVGElement>>;
  export default Svg;
}
