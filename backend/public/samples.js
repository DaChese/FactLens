(function () {
  'use strict';

  window.FACTLENS_SAMPLES = [
    {
      id: 'headline-match',
      label: 'Transcript with headline',
      description: 'A clear story with page context already available.',
      transcript: 'The Supreme Court heard arguments today over whether states can limit how large social media platforms moderate posts. Supporters of the state laws say platforms unfairly silence political viewpoints, while tech companies argue the laws violate their First Amendment right to choose what speech they host.',
      pageTitle: 'Supreme Court hears challenge to social media moderation laws',
      screenText: 'Justices weigh state laws that restrict how social media companies moderate political content.',
      outlet: 'apnews.com',
      language: 'english',
    },
    {
      id: 'missing-context',
      label: 'Missing context',
      description: 'A segment that gives one angle and may need other reporting.',
      transcript: 'Officials said the city approved a new emergency housing contract tonight after weeks of pressure over rising shelter demand. Supporters called it a fast response to a growing problem, but the segment did not mention how long the contract lasts or which company will operate the sites.',
      pageTitle: 'City approves emergency housing contract after shelter demand rises',
      screenText: 'Council vote follows pressure over capacity and winter shelter plans.',
      outlet: 'localnews.example',
      language: 'english',
    },
    {
      id: 'low-confidence',
      label: 'Ambiguous segment',
      description: 'Short context that may not identify one reliable story.',
      transcript: 'They said the plan could change next week, but nobody gave exact numbers during the briefing. More details are expected after the committee meets.',
      pageTitle: '',
      screenText: 'Breaking update: officials respond to questions.',
      outlet: '',
      language: 'english',
    },
  ];
})();
