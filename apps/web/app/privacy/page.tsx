import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/legal';

export const metadata: Metadata = { title: 'Privacy' };

const ISSUES = 'https://github.com/SoumiryaSarangi/CodeArena/issues';

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="8 October 2026">
      <p>
        CodeArena is a student-built online judge and contest platform. This page says what it
        stores about you and why. It is short on purpose.
      </p>

      <LegalSection title="What we store">
        <ul className="list-disc pl-5">
          <li>
            <strong>From Google or GitHub when you sign in:</strong> your name, e-mail address and
            profile picture. We never see your password.
          </li>
          <li>
            <strong>What you choose:</strong> your handle and default language.
          </li>
          <li>
            <strong>What you do here:</strong> the code you submit and run, the verdicts, your
            rating and contest results.
          </li>
          <li>
            <strong>Technical data:</strong> server logs that can include your IP address and the
            pages you request, used to run and protect the service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Cookies">
        <p>
          Only the cookies the site needs: one that keeps you signed in and one that protects forms
          against forgery. There are no advertising or tracking cookies, and no analytics.
        </p>
      </LegalSection>

      <LegalSection title="What it is used for">
        <p>
          Judging your code, showing your handle, rating and results on boards, keeping contests
          fair (including comparing contest submissions for similarity), and preventing abuse.
          Nothing is sold, and nothing is used for advertising.
        </p>
        <p>
          <strong>AI hints:</strong> only when you press &quot;Unlock&quot; in a problem&apos;s
          Coach tab, the problem text, your latest attempt on that problem (code and verdict) and
          the setter&apos;s notes are sent to an AI service (Groq or Google, through our relay on
          Vercel) to write the hint. No name, e-mail or other person&apos;s data is sent. The hint,
          which model wrote it and your helpful or not helpful rating are stored with your account.
          Hints are not available during contests.
        </p>
        <p>
          <strong>AI interview summaries:</strong> after an interview room has ended, its
          interviewer can press &quot;Write the summary&quot; on the replay page. To write it, the
          problem text, the code of the room&apos;s runs, their results, a timeline of the session
          (who typed how much by handle and role, pauses, language changes and restores) and, only
          if the interviewer ticks it, their own private notes are sent to an AI service (Groq or
          Google, through our relay on Vercel). No e-mail address is sent. If you took part as a
          candidate or an observer, your handle and what you did in the room are part of that. The
          summary is stored with the room and shown only to its interviewer; it describes what
          happened and does not score anyone.
        </p>
      </LegalSection>

      <LegalSection title="What is recorded during a contest">
        <p>
          While a contest runs and you are registered, the contest page reports four things for the
          organisers&apos; fairness review: when you opened each problem, how many characters you
          pasted into the editor when it is more than 50 (the size and the time, never the pasted
          text), and when the window lost or regained focus. From your submissions it also works out
          how long you took from opening a problem to your first accepted answer, and how much your
          code style differs from your own earlier programs.
        </p>
        <p>
          On some problems the organisers may add a sentence for automated assistants to the
          statement that people never see and screen readers skip; finding its variable name in code
          is shown to administrators as a weak signal.
        </p>
        <p>
          These are advisory hints shown to administrators next to similar submissions, clearly
          labelled, and are never used to change a score or ranking. They are deleted 30 days after
          the contest ends.
        </p>
      </LegalSection>

      <LegalSection title="Who can see it">
        <ul className="list-disc pl-5">
          <li>Everyone can see your handle and rating, and your place on a public board.</li>
          <li>Your submitted code is visible to you and to the site&apos;s administrators.</li>
          <li>
            Our service providers handle data on our behalf: Vercel (the website), Microsoft Azure
            (the servers, in Hong Kong), Google or GitHub (sign-in) and, for AI hints and interview
            summaries only, Groq and Google AI Studio.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Your choices">
        <p>
          You can sign out at any time. To have your account and data deleted, or to ask what we
          hold about you, open an issue at{' '}
          <a className="text-accent underline" href={ISSUES} rel="noopener noreferrer">
            {ISSUES}
          </a>
          . Deletion is not self-service yet.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          If this changes in a way that matters, the date above changes and sign-in will say so.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
