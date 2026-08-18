// Get site URL from environment variable, use default value if not set
// Note: Please set the correct PUBLIC_SITE_URL in .env file after first deployment
const SITE_URL = import.meta.env.PUBLIC_SITE_URL || '';

export const siteConfig = {
	title: "Borderlessify",
	author: "RicoUI",
	url: SITE_URL,
	mail: "borderlessify@gmail.com",
	utm: {
		source: `${SITE_URL}`,
		medium: "referral",
		campaign: "navigation",
	},
	meta:{
		title: "Borderlessify",
		description: "A polished, open-source SaaS template built with Astro and Tailwind CSS. Modular sections, dark mode, and a documented design system.",
		keywords: "saas template, astro template, tailwind template, startup website, landing page, indie hacker",
		image: `${SITE_URL}/og.jpg`,
		twitterHandle: "",
	},
	// social links
	social:{
		twitter: "",
		twitterName: "",
		github: "",
		blog: "",
	},
};
];
