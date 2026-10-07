import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/legal';

export const metadata: Metadata = { title: 'Terms' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="8 October 2026">
      <p>
        CodeArena is a student project that lets people practise programming problems and take part
        in contests. By signing in you agree to the points below.
      </p>

      <LegalSection title="Fair play">
        <ul className="list-disc pl-5">
          <li>Solve contest problems yourself. Do not share solutions during a contest.</li>
          <li>One account per person. Do not sign in for someone else.</li>
          <li>
            Contest submissions may be compared for similarity, and a flagged submission may be
            reviewed by a person before any decision is made.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="The judge">
        <ul className="list-disc pl-5">
          <li>
            Your code runs in a locked-down sandbox. Do not try to break out of it, attack the
            servers or other users, or use the judge for anything unrelated to the problem.
          </li>
          <li>Do not flood the service with requests. Limits exist and will be enforced.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Your code and content">
        <p>
          The code you submit is yours. You allow CodeArena to store it, run it, show it to you and
          to administrators, and use it for the fairness checks above. Do not submit anything that
          you do not have the right to share.
        </p>
      </LegalSection>

      <LegalSection title="No guarantees">
        <p>
          The service is provided as is, by students, without any promise of uptime or accuracy.
          Contest results can be corrected, for example after a problem is fixed and re-judged.
          Accounts that break these terms may be limited or removed.
        </p>
      </LegalSection>

      <LegalSection title="Privacy">
        <p>
          How personal data is handled is described on the{' '}
          <a className="text-accent underline" href="/privacy">
            privacy page
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
