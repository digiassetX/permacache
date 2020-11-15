require('nodeunit');
const Cache = require('../index');
const sleep=require('sleep-promise');
const isHex=/^[0-9a-f]+$/;  //only lowercase will be considered valid
const fs=require('fs');
const S3Buffer=require('s3buffer');

//generate some random files
const makeRandom=(length)=>{
    let data=Buffer.alloc(length);
    for (let i=0;i<length;i++) data[i]=Math.floor(Math.random()*256);
    return data;
}
const file0500=makeRandom(500);
const file0900=makeRandom(900);
const file1200=makeRandom(1200);
const file0400=makeRandom(400);
const file0300=makeRandom(300);
const fillFiles=[makeRandom(400),makeRandom(400),makeRandom(400),makeRandom(400),makeRandom(500),makeRandom(500),makeRandom(500),makeRandom(500)];

//make copy of a buffer so we know it checks buffers are same value and not necessarily same buffer
const copy0500=Buffer.from(file0500);
const copy0900=Buffer.from(file0900);
const copyLastFillFile=Buffer.from(fillFiles[fillFiles.length-1]);

module.exports = {
    'Test unlimited': async function(test) {
        //create cache
        let cache=new Cache({
            fileLimit: 0,
            totalLimit:0,
            pathLimit: 0
        });
        await cache.put(file0500,"a");
        test.equal(cache.size,500);
        test.done();
    },
    'Test No Longterm': async function(test) {
        //create cache
        let cache=new Cache({
            fileLimit:   1000,
            totalLimit:  5000,
            pathLimit:   5,
            debug:      false
        });

        //test some getters
        test.equal(cache.fileLimit,1000);
        test.equal(cache.totalLimit,5000);

        //add 500 bytes of data to cache and check hash returned is in correct format
        let hash0500=await cache.put(file0500,"a");
        test.equal(hash0500.length,64);
        test.equal(isHex.test(hash0500),true);
        test.equal(cache.size,500);

        //add another file and make sure size is correct
        await cache.put(file0900, "b");
        await sleep(5);
        test.equal(cache.size,1400);

        //try to add a file already in cache and make sure size does not increase but both paths work
        await cache.put(file0500,"c");
        await sleep(5);
        test.equal(cache.size,1400);
        test.equal(Buffer.compare(await cache.getByPath("a"),copy0500),0);
        await sleep(5);
        test.equal(Buffer.compare(await cache.getByPath("b"),copy0900),0);
        await sleep(5);
        test.equal(Buffer.compare(await cache.getByPath("c"),copy0500),0);
        await sleep(5);

        //try to get a file by its hash
        test.equal(Buffer.compare(await cache.getByHash(hash0500),copy0500),0);
        await sleep(5);

        //try to add a file that is to big for the buffer and make sure error is thrown since no longterm
        try {
            await cache.put(file1200,"d");
            test.equal("this line should never run",80);
        } catch (e) {
            test.equal("error was called because file to large","error was called because file to large");
        }

        //fill the buffer and make sure everything there
        for (let data of fillFiles) {
            await cache.put(data,"d");  //path should keep getting overwritten so only newest
            await sleep(5);
        }
        test.equal(cache.size,5000);
        test.equal(Buffer.compare(await cache.getByPath("d"),copyLastFillFile),0);
        await sleep(5);

        //add more data to buffer so it overflows and check that oldest data accessed was removed
        await cache.put(file0400);
        await sleep(5);
        try {
            console.log(await cache.getByPath("b"));
            test.equal("this line should never run",99);
        } catch (e) {
            test.equal("error was called because file no longer in cache","error was called because file no longer in cache");
        }

        //shrink the file limit then add a file less then old limit
        //note shrinking file limit does not remove any files that may exist above the old limit
        cache.fileLimit=600;
        try {
            console.log(await cache.put(file0900));
            test.equal("this line should never run",109);
        } catch (e) {
            test.equal("error was called because file to large","error was called because file to large");
        }

        //shrink ram allocation space and make sure new size total is less then that
        cache.totalLimit=2500;
        test.equal(cache.size,2400);

        //store file under multiple paths
        cache.totalLimit=5000;
        await cache.put(file0300,["xa","xb","xc","xd/a"]);
        test.equal(cache.size,2700);
        test.equal(Buffer.compare(await cache.getByPath("xa"),file0300),0);
        test.equal(Buffer.compare(await cache.getByPath("xb"),file0300),0);
        test.equal(Buffer.compare(await cache.getByPath("xc"),file0300),0);
        test.equal(Buffer.compare(await cache.getByPath("xd/a"),file0300),0);


        test.done();
    },








    'Test File System': async function(test) {
        //create cache
        let cache=new Cache({
            fileLimit:   1000,
            totalLimit:  5000,
            longterm:   "tests/temp",      //longTerm:    string|{accessKeyId: string,secretAccessKey: string,bucket: string},
            pathLimit:   5,
            debug:      false
        });

        //add some files and make sure they are in long term
        let hash0400=await cache.put(file0400,['a','test/56','test/59','test/5','test/4'],true);
        let hash1200=await cache.put(file1200,'b',true);
        test.equal(Buffer.compare(fs.readFileSync("./tests/temp/caches/"+hash0400),file0400),0);
        test.equal(Buffer.compare(fs.readFileSync("./tests/temp/caches/"+hash1200),file1200),0);
        test.equal(fs.readFileSync("./tests/temp/paths/a").toString('hex'),hash0400);
        test.equal(fs.readFileSync("./tests/temp/paths/test_56").toString('hex'),hash0400);
        test.equal(fs.readFileSync("./tests/temp/paths/test_59").toString('hex'),hash0400);
        test.equal(fs.readFileSync("./tests/temp/paths/test_5").toString('hex'),hash0400);
        test.equal(fs.readFileSync("./tests/temp/paths/test_4").toString('hex'),hash0400);
        test.equal(fs.readFileSync("./tests/temp/paths/b").toString('hex'),hash1200);

        //try deleting files starting with test/5
        await cache.deleteByPath("test/59");
        try {
            await cache.getByPath("test/59");
            test.equal("this line should never run",164);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }
        test.equal(fs.existsSync("./tests/temp/paths/test_59"),false);
        test.equal(fs.existsSync("./tests/temp/paths/test_56"),true);

        //try deleting all files starting with test/5
        await cache.deleteByPathStart("test/5");
        test.equal(fs.existsSync("./tests/temp/paths/test_4"),true);
        test.equal(fs.existsSync("./tests/temp/paths/test_56"),false);
        try {
            await cache.getByPath("test/56");
            test.equal("this line should never run",177);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }
        test.equal(fs.existsSync("./tests/temp/paths/test_59"),false);
        test.equal(fs.existsSync("./tests/temp/paths/test_5"),false);

        //destroy the RAM cache and see if still works from file system
        cache=false;
        cache=new Cache({
            fileLimit:   1000,
            totalLimit:  5000,
            longterm:   "tests/temp",
            pathLimit:   5,
            debug:      false,
            clearCheckInterval: 10000
        });
        test.equal(Buffer.compare(await cache.getByPath("a"),file0400),0);
        test.equal(Buffer.compare(await cache.getByHash(hash1200),file1200),0);

        //try to access information that does not exist
        try {
            await cache.getByPath("no_file");
            test.equal("this line should never run",200);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }

        //clear the cache by creating a clear file
        fs.writeFileSync("./tests/temp/clear","");
        await sleep(30000); //3 times the check frequency so should have run
        try {
            await cache.getByPath("a");
            test.equal("this line should never run",210);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }

        //check clear section
        test.equal(cache.size,0);
        await cache.put(file0400,'a',true);
        await cache.put(file0500,'b',true);
        test.equal(cache.size,900);
        await cache.clear();
        test.equal(cache.size,0);

        test.done();
    },








    'Test S3': async function(test) {
        const longterm={
            accessKeyId:     'REDACTED',
            secretAccessKey: 'REDACTED',
            bucket:          'REDACTED'
        }
        if (longterm.accessKeyId==="REDACTED") return;  //can't do test if keys are redacted.
        let cache=new Cache({
            fileLimit:   1000,
            totalLimit:  5000,
            longterm:    longterm,
            pathLimit:   5,
            debug:      false
        });

        //add some files and make sure they are in long term
        let hash0400=await cache.put(file0400,['a','test/56','test/59','test/5','test/4'],true);
        let hash1200=await cache.put(file1200,'b',true);
        test.equal(Buffer.compare(await cache.getByPath("a"),file0400),0);
        test.equal(Buffer.compare(await cache.getByPath("test/56"),file0400),0);
        test.equal(Buffer.compare(await cache.getByPath("test/59"),file0400),0);
        test.equal(Buffer.compare(await cache.getByPath("test/5"),file0400),0);
        test.equal(Buffer.compare(await cache.getByPath("test/4"),file0400),0);
        test.equal(Buffer.compare(await cache.getByPath("b"),file1200),0);

        //try deleting files starting with test/5
        await cache.deleteByPath("test/59");
        try {
            await cache.getByPath("test/59");
            test.equal("this line should never run",262);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }
        test.equal(Buffer.compare(await cache.getByPath("test/56"),file0400),0);

        //try deleting all files starting with test/5
        await cache.deleteByPathStart("test/5");
        test.equal(Buffer.compare(await cache.getByPath("test/4"),file0400),0);
        try {
            await cache.getByPath("test/56");
            test.equal("this line should never run",273);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }

        //destroy the RAM cache and see if still works from s3 bucket
        cache=false;
        cache=new Cache({
            fileLimit:   1000,
            totalLimit:  5000,
            longterm:    longterm,
            pathLimit:   5,
            debug:      false,
            clearCheckInterval: 30000
        });
        test.equal(Buffer.compare(await cache.getByPath("a"),file0400),0);
        test.equal(Buffer.compare(await cache.getByHash(hash1200),file1200),0);

        //try to access information that does not exist
        try {
            await cache.getByPath("no_file");
            test.equal("this line should never run",294);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }

        //clear the cache by creating a clear file
        let s3buffer=new S3Buffer(longterm);
        await s3buffer.write('clear',new Buffer.alloc(1));
        await sleep(90000); //3 times the check frequency so should have run
        try {
            await cache.getByPath("a");
            test.equal("this line should never run",305);
        } catch (e) {
            test.equal("error was called because path doesn't exist","error was called because path doesn't exist");
        }

        test.done();
    }
};

