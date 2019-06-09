A simple imageboard like site with bump ordered content where user needs to create their own client to join

# db setup

+ `sudo -u postgres createuser -P -s -e yell_admin` and set account password: `yell_pass`
+ `sudo -u postgres createdb yell --owner yell_admin`
+ `sudo psql -U yell_admin -d yell -h localhost -W < node_modules/connect-pg-simple/table.sql`
+ `sudo psql -U yell_admin -d yell -h localhost -W < setup.sql`