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
		description: "a program that makes games and windows that dont support borderless. Borderless",
		keywords: "borderless window, borderless gaming, borderless fullscreen, windowed mode, fullscreen games, game utility, windows utility, window manager, gaming tool, borderless windowed, pc gaming, game optimization"
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
