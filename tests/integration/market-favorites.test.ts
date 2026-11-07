import { describe, expect, it } from 'vitest';
import * as favorites from '@/app/api/v1/account/favorites/route';
import * as favorite from '@/app/api/v1/account/favorites/[slug]/route';
import * as exploreRoute from '@/app/api/v1/account/explore/route';
import * as search from '@/app/api/v1/market/search/route';
import * as listing from '@/app/api/v1/t/[tenantSlug]/marketplace/route';
import { TestClient } from '../helpers/http';
import { customer, makeSalon } from '../helpers/salon';
import { listedBusiness } from '../helpers/market';

describe('سوق لوما: favourites and «استكشفي»', () => {
  it('requires login, only lists marketplace businesses, suggests same-city first', async () => {
    const city = `fav-${Math.random().toString(36).slice(2, 7)}`;
    const a = await listedBusiness({ name: 'صالون المفضلة', city });
    const near = await listedBusiness({ name: 'صالون قريب', city });
    const unlisted = await makeSalon();
    const c = await customer('Noura');

    expect((await new TestClient().call(favorites.POST, { body: { slug: a.slug } })).status).toBe(401);
    expect((await new TestClient().call(exploreRoute.GET)).status).toBe(401);
    expect((await c.call(favorites.POST, { body: { slug: unlisted.slug } })).status).toBe(404);

    expect((await c.call(favorites.POST, { body: { slug: a.slug } })).status).toBe(201);
    expect((await c.call(favorites.POST, { body: { slug: a.slug } })).status).toBe(201); // idempotent
    const list = await c.call(favorites.GET);
    expect(list.body.data.items.map((i: any) => i.slug)).toEqual([a.slug]);
    expect(list.body.data.items[0].favorite).toBe(true);

    // The search marks favourites for the signed-in customer only.
    const mine = await c.call(search.GET, { query: { city } });
    expect(mine.body.data.items.find((i: any) => i.slug === a.slug).favorite).toBe(true);
    const anon = await new TestClient().call(search.GET, { query: { city } });
    expect(anon.body.data.items.every((i: any) => i.favorite === false)).toBe(true);

    const ex = await c.call(exploreRoute.GET);
    expect(ex.body.data.favorites.map((i: any) => i.slug)).toEqual([a.slug]);
    expect(ex.body.data.suggestions[0]).toMatchObject({ slug: near.slug, reason: 'same_city' });
    expect(ex.body.data.suggestions.map((i: any) => i.slug)).not.toContain(a.slug);

    // Hidden businesses drop out of favourites until shown again; removal works.
    await a.owner.call(listing.PATCH, { params: { tenantSlug: a.slug }, method: 'PATCH', body: { hidden: true } });
    expect((await c.call(favorites.GET)).body.data.items).toEqual([]);
    await a.owner.call(listing.PATCH, { params: { tenantSlug: a.slug }, method: 'PATCH', body: { hidden: false } });
    expect((await c.call(favorite.DELETE, { method: 'DELETE', params: { slug: a.slug } })).status).toBe(200);
    expect((await c.call(favorites.GET)).body.data.items).toEqual([]);
    // Another customer's favourites are separate.
    const other = await customer('Other');
    expect((await other.call(favorites.GET)).body.data.items).toEqual([]);
  });
});
