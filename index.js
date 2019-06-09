const express = require('express');
const app     = express();
// const session = require('express-session');
const helmet  = require('helmet');
const faker   = require('faker');
const val     = require('validator');
const uuid    = require('uuid/v4');
const pgp     = require('pg-promise')();
const svgc    = require('svg-captcha');
const path    = require('path');
const xss     = require('xss-filters');
const https   = require('https');
const fs      = require('fs');

svgc.options.size = 4;
svgc.options.charPreset = '0123456789';

const this_dir   = path.dirname(__filename);
const public_dir = path.join(this_dir, 'public');
const index_html = path.join(public_dir, 'index.html');

const err_json = { error : `Unexepected error`, report_to : 'bug@example.org' }

const page_cache_limit = 30 * 1000;
const page_cache =
{
    0 : { t : 0, p : [] },
    1 : { t : 0, p : [] },
    2 : { t : 0, p : [] },
    3 : { t : 0, p : [] },
    4 : { t : 0, p : [] },
    5 : { t : 0, p : [] },
    6 : { t : 0, p : [] },
    7 : { t : 0, p : [] },
    8 : { t : 0, p : [] },
    9 : { t : 0, p : [] }
};

// TODO: thread limit

let https_options;
if(process.env.fullchain && process.env.privkey) https_options =
{
    cert: fs.readFileSync(process.env.fullchain),
    key: fs.readFileSync(process.env.privkey)
};

if(process.env.fullchain && process.env.privkey) app.use((req, res, next) =>
{
    if(!req.secure)
        return res.redirect(['https://', req.get('Host'), req.url].join(''));
    else
        next();
});

const db = pgp
(
    process.env.DATABASE_URL || `postgres://yell_admin:yell_pass@localhost:5432/yell`
);

app.use(express.static(public_dir));
app.use(helmet());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(index_html));

app.get('/page/:num', async (req, res) =>
{
    try
    {
        if(!val.isNumeric(req.params.num))
            return res.status(400).json({ error : 'need /page/<number>' });

        req.params.num = Math.round(Number(req.params.num));
        if(req.params.num < 0) req.params.num = 0;

        if
        (
            req.param.num < 10 &&
            !req.query.by_time &&
            (new Date().getTime() - page_cache[req.param.num].t) < page_cache_limit
        )
        {
            return page_cache[req.param.num].p;
        }

        let posts = await db.any
        (
            `
            SELECT
                id,
                content,
                pic,
                created,
                (SELECT COUNT(*) FROM post WHERE on_thread = p.id)::int AS replies
            FROM post as p
            WHERE
                on_thread=-1
            ${req.query.by_time == '1' ?
                `ORDER BY created DESC` :
                `ORDER BY bumped DESC`}
            OFFSET $1 LIMIT 15`,
            [req.params.num * 15]
        );
        posts.forEach(p =>
        {
            p.content = xss.inHTMLData(val.unescape(p.content));
            p.pic = val.unescape(p.pic);
        });
        if(req.param.num < 10 && !req.query.by_time)
        {
            page_cache[req.param.num].t = new Date().getTime();
            page_cache[req.param.num].p = posts;
        }
        return res.json(posts);
    }
    catch(err)
    {
        console.error(err);
        return res.status(500).json(err_json);
    }
});

setInterval(async () =>
{
    try
    {
        let ids = await db.any
        (
            `
            DELETE FROM post
            WHERE id IN
            (
                SELECT id FROM post
                WHERE on_thread=-1
                ORDER BY bumped DESC
                OFFSET 150
            )
            RETURNING id
            `
        );

        if(ids.length)
        {
            await db.none
            (
                `
                DELETE FROM post
                WHERE on_thread IN
                (${ids.map((a) => a.id).join(',')})
                `
            );
        }
    }
    catch(err)
    {
        console.error(err);
    }

}, 2*60*1000);

app.get('/captcha', async (req, res) =>
{
    try
    {
        return res.json({ ...await set_captcha_get_svg(req) });
    }
    catch(err)
    {
        console.error(err);
        return res.status(500).json(err_json);
    }
});

app.post('/post/', async (req, res) =>
{
    try
    {
        req.body.content = req.body.content ? req.body.content.trim() : undefined;
        if(!req.body.content || !req.body.content.length)
        {
            return res.status(400).json({ error : 'no content received' });
        }
        if(! await captcha_is_valid(req))
        {
            req.body.error = 'captcha solution incorrect';
            req.body = { ...req.body, ...await set_captcha_get_svg(req) }
            delete req.body.captcha_solution;
            return res.status(409).json(req.body);
        }

        if(!req.body.pic || !val.isURL(req.body.pic)) req.body.pic = '';
        else if
        (
            req.body.pic.indexOf('https://i.postimg.cc/') !== 0 &&
            req.body.pic.indexOf('https://i.imgur.com/')  !== 0
        )
        {
            req.body.error = 'Not a supported image URL';
            req.body = { ...req.body, ...await set_captcha_get_svg(req) }
            delete req.body.captcha_solution;
            return res.status(409).json(req.body);
        }

        if(!req.body.on_thread || !val.isInt(req.body.on_thread))
        {
            req.body.on_thread = -1;
        }
        else
        {
            req.body.on_thread = Number.parseInt(req.body.on_thread, 10);

            if(req.body.on_thread <= 0)
            {
                req.body.error = `can't comment on a non-existent thread`;
                req.body = { ...req.body, ...await set_captcha_get_svg(req) }
                delete req.body.captcha_solution;
                delete req.body.on_thread;
                return res.status(403).json(req.body);
            }

            try
            {
                await db.none
                (
                    `
                    UPDATE post
                    SET bumped = NOW()
                    WHERE id=${req.body.on_thread} AND on_thread=-1`
                );
            }
            catch(err)
            {
                console.error(err);
                req.body.error = `can't comment on a non-existent thread`;
                req.body = { ...req.body, ...await set_captcha_get_svg(req) }
                delete req.body.captcha_solution;
                return res.status(403).json(req.body);
            }
        }

        let out = await db.one
        (
            `
            INSERT INTO post
            (content, on_thread, delete_code, pic)
            VALUES($1, $2, $3, $4)
            RETURNING id, delete_code`,
            [
                val.escape(req.body.content),
                req.body.on_thread,
                faker.random.alphaNumeric(4),
                val.escape(req.body.pic)
            ]
        );

        return res.json({ ...out, ...await set_captcha_get_svg(req) });
    }
    catch(err)
    {
        console.error(err);
        return res.status(500).json(err_json);
    }
});

app.post('/delete/', async (req, res, next) =>
{
    try
    {
        if(!req.body.id || !val.isInt(req.body.id))
            return res.status(400).json({ error : 'invalid id' });
        else if(!req.body.delete_code)
            return res.status(400).json({ error : 'no delete_code recieved' });

        req.body.id = parseInt(req.body.id, 10);
        let delete_res = await db.result
        (
            `DELETE FROM post WHERE id=$1 AND delete_code=$2 RETURNING on_thread`,
            [
                req.body.id,
                val.escape(req.body.delete_code)
            ]
        );

        if(delete_res.rowCount)
        {
            if(delete_res.rows[0].on_thread === -1) try
            {
                await db.none(`DELETE FROM post WHERE on_thread=$1`, [ req.body.id ]);
            }
            catch(err)
            {
                console.error(err);
            }

            return res.json({ deleted : req.body.id });
        }
        else
        {
            return res.status(404)
            .json({ error : 'given id and delete_code combination was not found' });
        }
    }
    catch(err)
    {
        console.error(err);
        return res.status(500).json(err_json);
    }
});

app.get('/post/:id', async (req, res, next) =>
{
    try
    {
        if(req.params.id && !val.isInt(req.params.id))
            return res.status(400).json({ error : 'invalid id' });

        let posts = await db.any
        (
            `
            SELECT
                id,
                pic,
                on_thread,
                content,
                created
            FROM
                post
            WHERE
                id = $1 OR on_thread = $1
            ORDER BY created`,
            [req.params.id]
        );

        if(posts) posts.forEach((post) =>
        {
            post.content = xss.inHTMLData(val.unescape(post.content));
            post.pic     = val.unescape(post.pic);
        });

        return posts.length ? res.json(posts) : res.status(404).json(posts);
    }
    catch(err)
    {
        console.error(err);
        return res.status(500).json(err_json);
    }
});

app.all('*', (req, res) => res.status(404).sendFile(index_html));

//-------------
async function captcha_is_valid(req)
{
    if
    (
        req.body.captcha_id                     &&
        req.body.captcha_id.length === 4        &&
        val.isAlphanumeric(req.body.captcha_id) &&
        req.body.captcha_solution               &&
        req.body.captcha_solution.constructor === String &&
        req.body.captcha_solution.length === 4
    )
    {
        try
        {
            let res = await db.one
            (
                `DELETE FROM captcha WHERE id=$1 RETURNING solution`,
                req.body.captcha_id
            );

            return res.solution === req.body.captcha_solution;
        }
        catch(err)
        {
            if(err.code !== 0) console.error(err); // returned none
            return false;
        }
    }

    return false;
}

async function set_captcha_get_svg(req)
{
    let captcha = svgc.create();
    captcha.captcha_id = faker.random.alphaNumeric(4);
    await db.none
    (
        `INSERT INTO captcha(id, solution) VALUES ($1, $2)`,
        [ captcha.captcha_id, captcha.text ]
    );

    captcha.captcha_svg = captcha.data;
    delete captcha.data;
    delete captcha.text;
    return captcha;
}
// ---------------

setInterval(async () =>
{
    try
    {
        await db.none
        (
            `
            DELETE FROM captcha
            WHERE
                created >
                '${new Date(new Date().getTime() + (5*60*1000)).toISOString()}'
            `
        );
    }
    catch(err)
    {
        console.error(err);
    }

}, 5*60*1000);

app.listen(process.env.PORT || '9001').on('listening', () =>
{
	if(process.env.fullchain && process.env.privkey)
		https.createServer(https_options, app).listen(443);
	console.info('Started');
});
