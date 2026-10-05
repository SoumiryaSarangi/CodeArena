import { notFound } from 'next/navigation';
import { KitchenSink } from './kitchen-sink';

export const metadata = { title: 'UI kitchen sink' };

/** Development-only catalogue of every component (F-07). Hidden in production builds. */
export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <KitchenSink />;
}
