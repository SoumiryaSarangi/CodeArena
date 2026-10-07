import type { Metadata } from 'next';
import { ProblemSetter } from '@/components/admin/problem-setter';
import { SetterGate } from '@/components/admin/setter-gate';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} · Admin` };
}

export default async function AdminProblemPage({ params }: Props) {
  const { slug } = await params;
  return (
    <SetterGate>
      <ProblemSetter slug={slug} />
    </SetterGate>
  );
}
