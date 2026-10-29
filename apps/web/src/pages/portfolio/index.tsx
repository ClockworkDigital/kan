import type { NextPageWithLayout } from "../_app";
import { getDashboardLayout } from "~/components/Dashboard";
import PortfolioView from "~/views/portfolio";

const PortfolioPage: NextPageWithLayout = () => <PortfolioView />;
PortfolioPage.getLayout = (page) => getDashboardLayout(page);
export default PortfolioPage;
