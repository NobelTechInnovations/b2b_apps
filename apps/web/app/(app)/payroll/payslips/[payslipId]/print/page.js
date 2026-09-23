import PayslipPrint from './print-client';

export const metadata = { title: 'Payslip' };

export default async function PayslipPrintPage({ params }) {
  const { payslipId } = await params;
  return <PayslipPrint payslipId={payslipId} />;
}
