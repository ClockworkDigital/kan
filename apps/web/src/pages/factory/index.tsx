import type { NextPageWithLayout } from "../_app";
import { getDashboardLayout } from "~/components/Dashboard";
import FactoryView from "~/views/factory";

const FactoryPage: NextPageWithLayout = () => <FactoryView />;
FactoryPage.getLayout = (page) => getDashboardLayout(page);
export default FactoryPage;
