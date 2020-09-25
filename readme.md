# permacache



## Installation
``` bash
npm install permacache
```

## File System:
For long term storage you can use the file system or s3 buckets.  File system is faster but if there is a lot of data S3 may be a lot cheaper and scales automatically
``` javascript
const Cache=require('permacache');
let cache=new Cache({
    longterm:   "tests/temp"
});
let hash=await cache.put(someBuffer,'optional_path');
console.log(await cache.getByHash(hash));
console.log(await cache.getByPath('optional_path'));
```



## S3 setup
Amazon AWS s3 is a very cost effective way to create really large permanent caches.  If you already have an AWS account here are the instructions to setup.  Keep in mind Amazon may change the layout of there site at any time so if the instructions don't work exactly look around for what they may have changed.

##### Create a bucket
    1. Click Services in top left corner then select S3 under Storage
    2. Click blue "Create bucket" button
    3. Give your bucket a name.
    4. Set the region to the same as your server.
    5. Press Create
    6. Note down the bucket name you will need that later
    
##### Create a user
    1. Click Service in top left corner then select IAM under Security, Identity, & Compliance
    2. Click on Users
    3. Click blue "Add user" button
    4. Assign a user name
    5. select Programmatic access
    6. click blue "Next: Permissions button"
    7. click blue "Next: Tags"
    8. click blue "Next: Review"
    9. click blue "Create user"
    10. note down "Access key ID" and "Secret access key" you will need that later
    
##### Assign a user to the bucket
    1. Click Service in top left corner then select IAM under Security, Identity, & Compliance
    2. Click on Users
    3. Click on the user you wish to assign to the bucket
    4. CLick on "+ Add inline policy"
    5. Select Service S3
    6. Select Actions "Read: GetObject" and "Write: PutObject"
    8. When Resource, Specific is select click "Add ARN" 
    9. Enter the bucket you wish to use and put * for the Object name then press Add
    10. Press blue "Review Policy" button
    11. Give the policy a name

##### Usage
``` javascript
const Cache=require('permacache');
let cache=new Cache({
    longterm:   {
        accessKeyId: "Value from above",
        secretAccessKey: "Value from above",
        bucket: "Value from above"
    }
});
let hash=await cache.put(someBuffer,'optional_path');
console.log(await cache.getByHash(hash));
console.log(await cache.getByPath('optional_path'));
```
