import rss from "@astrojs/rss";
import { getCollection } from "astro:content";

export async function GET(context) {
  const blog = await getCollection('post');
  return rss({
    title: 'Borderlessify',
    description: 'ppdates and articles from Borderlessify â€” make any game or window borderless.',
    site: context.site,
    items: blog.map((post) => {
      const link = `/blog/${post.id}/`;
      return {
        title: post.data.title,
        pubDate: post.data.publishDate,
        description: post.data.description,
        link,
        stylesheet: '/rss/pretty-feed-v3.xsl',
      };
    }),
  });
}