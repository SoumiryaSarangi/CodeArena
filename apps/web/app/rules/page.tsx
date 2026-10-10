import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/legal';

export const metadata: Metadata = { title: 'Contest rules' };

export default function RulesPage() {
  return (
    <LegalPage title="Contest rules" updated="10 October 2026">
      <p>
        These rules apply to every CodeArena contest. A contest&apos;s own page lists its exact
        numbers (penalty, language multipliers, whether it is rated); where it differs from this
        page, the contest page wins.
      </p>

      <LegalSection title="Scoring and ranking">
        <ul className="list-disc pl-5">
          <li>
            You are ranked by problems solved, then by penalty, then by the time of your last
            accepted solution. Equal results share a rank.
          </li>
          <li>
            Penalty is the minutes from the start to your first accepted solution on a problem, plus
            a fixed number of minutes for each rejected attempt before it. Problems you did not
            solve add nothing. The contest page says whether compile errors count as attempts.
          </li>
          <li>
            Time limits are multiplied by language, and the multipliers are shown on the contest
            page.
          </li>
          <li>
            Near the end the board may freeze. Your own submissions still show their verdicts, and
            the final board is revealed after the contest.
          </li>
          <li>
            Results can be corrected, for example when a problem is fixed and re-judged. Rated
            contests change your rating once, after they are finalised.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Fair play">
        <ul className="list-disc pl-5">
          <li>
            Solve the problems yourself. Do not share, ask for or copy solutions while a contest is
            running, and do not take part for someone else.
          </li>
          <li>
            The Coach and hints are switched off in contests. Other tools are not policed by the
            site, so follow the rules the organisers give you.
          </li>
          <li>
            Do not attack the judge, the servers or other participants, and do not flood the service
            with requests.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="What is recorded, and what happens with it">
        <ul className="list-disc pl-5">
          <li>
            While a contest runs and you are registered, the page records when you open each
            problem, the size and time of larger pastes (never the pasted text), and when the window
            loses or regains focus.
          </li>
          <li>
            Submissions are compared with each other for similarity, and the system works out how
            long you took to your first accepted answer and how much your code style changed.
          </li>
          <li>
            These are advisory hints. They are shown to administrators next to similar submissions,
            labelled as advisory, and a person looks at them.{' '}
            <strong>Nothing is decided automatically</strong>: a flagged submission is reviewed,
            never banned by the system, and the decision and its reason are logged. No score or rank
            changes unless an administrator confirms a case and applies it.
          </li>
          <li>
            Signals are deleted 30 days after the contest ends. More detail is on the{' '}
            <a className="text-accent underline" href="/privacy">
              privacy page
            </a>
            .
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Exam mode">
        <p>Some contests are run as tests. Their page says so before they start, and then:</p>
        <ul className="list-disc pl-5">
          <li>
            You enter once and can finish your test early. After that you cannot open the problems,
            submit or run code, although submissions already sent are still judged and counted.
          </li>
          <li>
            Leaving the test window (switching tab or app, or leaving full screen) is counted by the
            server. The first two times you get a warning; the third time your test is finished for
            you. Leaves less than two seconds apart count once.
          </li>
          <li>
            Only the number of leaves and the time and cause of finishing are recorded, nothing
            about your screen, device or other tabs.
          </li>
          <li>
            This is a deterrent, not proctoring: a notification or pop-up can also count as a leave.
            If that happens to you, tell the organisers, who can reopen your test.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Questions during a contest">
        <p>
          Ask with the Clarifications button in the contest. Answers that matter to everyone are
          shown to everyone. See also the{' '}
          <a className="text-accent underline" href="/terms">
            terms of use
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
